#!/usr/bin/env node
// Vast.ai pod lifecycle — separate manual steps; the pod serves ONLY the model
// (vLLM), everything else (harness, vault server, judge, results) stays local.
// Zero deps.
//
//   1. node evals/vast.mjs search [--max-price 1.50] [--country US]
//      → browse qualifying offers, pick an offer ID yourself
//   2. node evals/vast.mjs start --offer <ID> [--model Qwen/Qwen3.5-35B-A3B-FP8] [--dry-run]
//      → create the pod, wait for weights, write evals/.vast.env, start the shim
//      start = create + wait + shim; each is also its own command, so an
//      interrupted start resumes with `wait` then `shim` (the pod key is
//      persisted to evals/.vast.env at create time, nothing is lost to ^C):
//        node evals/vast.mjs create --offer <ID>   → create pod, write id + key
//        node evals/vast.mjs wait                  → poll until vLLM serves, write base URL
//        node evals/vast.mjs shim                  → start the local LiteLLM shim
//   3. node evals/vast.mjs status
//      → instance state + $/hr, model loaded?, shim up?, measured RTT
//   4. node evals/vast.mjs probe [--harness claude,codex]
//      → 6-run transport-reliability gate; require 6/6 before trusting cells
//   5. run suites yourself, exactly like any provider — results/analyze local:
//        node evals/run.mjs --suite micro --baselines --harness claude \
//          --provider vast --model qwen3.5-35b-a3b --bare
//   6. node evals/vast.mjs down   ← manual; per-second billing, don't forget
//
// Keys (evals/.env): VAST_ACCOUNT_API_KEY = your Vast.ai account key (REST auth
// only, never sent to the model). Pod state (generated → evals/.vast.env):
// VAST_INSTANCE_ID, VAST_UPSTREAM_OPENAI_BASE_URL, VAST_API_KEY (per-pod vLLM
// key — the key the eval drivers send, per the <PROVIDER>_API_KEY convention),
// VAST_SHIM_PID. Network note: prefer an in-region host — RTT hides behind
// 5-15s generation turns, and higher --qa-concurrency cancels the rest.

import { spawn } from "node:child_process";
import { writeFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drivers, resolveBackend } from "./drivers/index.mjs";
import {
  EVALS_DIR, cliArgs, loadDotEnv, parseEnvFile, spawnVaultServer,
  qaVaultPrompt, VAULT_READ_TOOLS,
} from "./lib.mjs";

const VAST_ENV = join(EVALS_DIR, ".vast.env");
const API = "https://console.vast.ai/api/v0";
const SHIM_PORT = 4042;

loadDotEnv();

const { argv, opt, flag } = cliArgs();
const cmd = argv[0];

const cfg = {
  maxPrice: Number(opt("max-price", 1.5)),
  country: opt("country", null),
  offer: opt("offer", null),
  model: opt("model", "Qwen/Qwen3.5-35B-A3B-FP8"),
  servedName: opt("served-name", "qwen3.5-35b-a3b"),
  harnesses: opt("harness", "claude,codex").split(",").map((s) => s.trim()),
  provider: opt("provider", "vast"),
  dryRun: flag("dry-run"),
};

// ── Vast REST ─────────────────────────────────────────────────────────────────

function accountKey() {
  const k = process.env.VAST_ACCOUNT_API_KEY;
  if (!k) throw new Error("VAST_ACCOUNT_API_KEY not set — get it from cloud.vast.ai → Account → API Key, put it in evals/.env");
  return k;
}

async function vast(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accountKey()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`vast ${method} ${path}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// FP8 needs compute capability >= 8.9 (Ada/Hopper/Blackwell) — excludes A100.
async function searchOffers() {
  const q = {
    gpu_ram: { gte: 79000 },
    num_gpus: { eq: 1 },
    compute_cap: { gte: 890 },
    reliability2: { gte: 0.99 },
    inet_down: { gte: 500 },
    disk_space: { gte: 80 },
    rentable: { eq: true },
    verified: { eq: true },
    order: [["dph_total", "asc"]],
    type: "on-demand",
  };
  const res = await fetch(`${API}/bundles/?q=${encodeURIComponent(JSON.stringify(q))}`);
  if (!res.ok) throw new Error(`offer search: HTTP ${res.status}`);
  const { offers } = await res.json();
  // --country matches the trailing country code ("Illinois, US" → "US"), not a
  // substring (which would let "US" match "AUstralia").
  const wantCode = cfg.country?.toLowerCase();
  return offers.filter((o) =>
    o.dph_total <= cfg.maxPrice &&
    (!wantCode || (o.geolocation ?? "").split(",").pop().trim().toLowerCase() === wantCode));
}

const offerRow = (o) =>
  `${String(o.id).padEnd(10)} ${o.gpu_name.padEnd(22)} ${Math.round(o.gpu_ram / 1024)}GB  $${o.dph_total.toFixed(3)}/hr  rel ${(o.reliability2 * 100).toFixed(1)}%  ${Math.round(o.inet_down)}Mbps  ${o.geolocation ?? ""}`;

// ── Pod state ─────────────────────────────────────────────────────────────────

async function readState() {
  const state = parseEnvFile(VAST_ENV);
  return state?.VAST_INSTANCE_ID ? state : null;
}

async function writeState(state) {
  const lines = ["# generated by evals/vast.mjs — pod state; removed by `vast.mjs down`"];
  for (const [k, v] of Object.entries(state)) if (v != null) lines.push(`${k}=${v}`);
  await writeFile(VAST_ENV, lines.join("\n") + "\n");
}

// ── up ────────────────────────────────────────────────────────────────────────

function vllmArgs(apiKey) {
  return [
    "--model", cfg.model,
    "--served-model-name", cfg.servedName,
    "--host", "0.0.0.0", "--port", "8000",
    "--max-model-len", "65536",
    "--kv-cache-dtype", "fp8",
    "--enable-auto-tool-choice",
    "--tool-call-parser", "qwen3_coder",
    "--reasoning-parser", "qwen3",
    "--api-key", apiKey,
  ].join(" ");
}

// Step 1 — create the pod. The instance id AND the generated vLLM key are
// persisted to evals/.vast.env immediately: the key is baked into the
// container's args, so losing it locally (a ^C mid-start used to) makes the
// pod unusable. Returns the instance id, or null on --dry-run / already-up.
async function createPod() {
  if (await readState()) { console.log("pod already created (evals/.vast.env exists) — `vast.mjs wait`, `status`, or `down`"); return null; }
  if (!cfg.offer)
    throw new Error("create requires --offer <id> — pick one from `node evals/vast.mjs search` (you choose, nothing auto-picks)");
  const offers = await searchOffers().catch(() => []);
  const offer = offers.find((o) => String(o.id) === cfg.offer) ?? { id: cfg.offer };
  const vllmKey = "vllm-" + randomBytes(16).toString("hex");
  const payload = {
    client_id: "me",
    image: "vllm/vllm-openai:latest",
    disk: 80,
    runtype: "args",
    args_str: vllmArgs(vllmKey),
    env: { "-p 8000:8000": "1" },
    label: "memory-vault-eval",
  };
  console.log(`offer: ${offer.gpu_name ? offerRow(offer) : offer.id}`);
  if (cfg.dryRun) { console.log("create payload:", JSON.stringify(payload, null, 2)); return null; }

  let created;
  try {
    created = await vast("PUT", `/asks/${offer.id}/`, payload);
  } catch (e) {
    if (/no_such_ask|not available/i.test(e.message)) {
      // Offers are auction listings — they churn within minutes of a search.
      console.error(`offer ${offer.id} is gone (rented or relisted — IDs go stale fast).`);
      const fresh = await searchOffers().catch(() => []);
      if (fresh.length) {
        console.error("\nlive right now — pick one and start it immediately:");
        fresh.slice(0, 6).forEach((o) => console.error(offerRow(o)));
      }
      process.exit(1);
    }
    throw e;
  }
  const id = created.new_contract ?? created.new_id ?? created.id;
  if (!id) throw new Error(`create returned no instance id: ${JSON.stringify(created).slice(0, 300)}`);
  await writeState({ VAST_INSTANCE_ID: id, VAST_API_KEY: vllmKey });
  console.log(`instance ${id} created — id + vLLM key saved to evals/.vast.env`);
  return id;
}

// Step 2 — poll the instance until it runs with a mapped port, then vLLM until
// the model loads; write the upstream base URL into evals/.vast.env. Standalone
// `wait` leaves a timed-out instance RUNNING (rerun `wait`, or `down`); only
// the composed `start` destroys on timeout.
async function waitForVllm({ destroyOnTimeout = false } = {}) {
  const state = await readState();
  if (!state) throw new Error("no pod (evals/.vast.env absent) — `vast.mjs create --offer <id>` first");
  if (!state.VAST_API_KEY)
    throw new Error("evals/.vast.env has no VAST_API_KEY (stale pre-split state) — `vast.mjs down`, then start over");
  if (state.VAST_UPSTREAM_OPENAI_BASE_URL) {
    console.log(`already provisioned: ${state.VAST_UPSTREAM_OPENAI_BASE_URL}`);
    return state.VAST_UPSTREAM_OPENAI_BASE_URL;
  }
  const id = state.VAST_INSTANCE_ID;
  console.log(`waiting for instance ${id} (weights ~31GB; this takes minutes)`);
  const deadline = Date.now() + 25 * 60_000;
  let base = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    let inst;
    try { inst = (await vast("GET", `/instances/${id}/`)).instances ?? (await vast("GET", `/instances/${id}/`)); } catch { continue; }
    const status = inst.actual_status ?? inst.cur_state;
    const port = inst.ports?.["8000/tcp"]?.[0]?.HostPort;
    process.stdout.write(`  status=${status ?? "?"} ip=${inst.public_ipaddr ?? "?"} port=${port ?? "?"}\r`);
    if (status === "running" && inst.public_ipaddr && port) {
      base = `http://${inst.public_ipaddr}:${port}/v1`;
      try {
        const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${state.VAST_API_KEY}` }, signal: AbortSignal.timeout(5000) });
        if (r.ok) { console.log(`\nvLLM ready at ${base}`); break; }
      } catch {}
      base = null;
    }
  }
  if (!base) {
    if (destroyOnTimeout) {
      console.error("\ntimed out waiting for vLLM — destroying instance");
      await vast("DELETE", `/instances/${id}/`, {}).catch(() => {});
      await rm(VAST_ENV, { force: true });
    } else {
      console.error("\ntimed out waiting for vLLM — instance LEFT RUNNING (billing): rerun `vast.mjs wait`, or `vast.mjs down`");
    }
    process.exit(1);
  }
  await writeState({ ...state, VAST_UPSTREAM_OPENAI_BASE_URL: base });
  process.env.VAST_UPSTREAM_OPENAI_BASE_URL = base;
  process.env.VAST_API_KEY = state.VAST_API_KEY;
  return base;
}

// start = create + wait + shim, nothing more.
async function start() {
  if (await readState()) { console.log("pod already up (evals/.vast.env exists) — `vast.mjs status` or `down` first"); return; }
  const id = await createPod();
  if (!id) return; // --dry-run
  await waitForVllm({ destroyOnTimeout: true });
  await startShim();
  console.log("pod state written to evals/.vast.env");
  console.log("next: `node evals/vast.mjs status`, then `probe`, then run cells with --provider vast");
}

// Step 3 — the local shim chain: LiteLLM (Anthropic wire → chat) on :4042,
// then the system-message hoist (evals/vast-hoist.mjs) on :4043, then the pod.
// The hoist merges the multiple system messages that non-bare Claude Code
// (native-memory cells) produces through the anthropic→chat translation —
// vLLM 400s on a system message that isn't first. It's idempotent for clean
// requests, so the codex route through it is unaffected.
const HOIST_PORT = 4043;
async function startShim() {
  const state = await readState();
  if (!state) throw new Error("no pod up — `vast.mjs create` first");
  if (!state.VAST_UPSTREAM_OPENAI_BASE_URL)
    throw new Error("pod not provisioned yet (no upstream URL in evals/.vast.env) — `vast.mjs wait` first");
  let hoistPid = state.VAST_HOIST_PID ?? null;
  let hoistUp = false;
  try {
    const r = await fetch(`http://127.0.0.1:${HOIST_PORT}/v1/models`, {
      headers: { Authorization: `Bearer ${state.VAST_API_KEY}` }, signal: AbortSignal.timeout(4000) });
    hoistUp = r.ok;
  } catch {}
  if (hoistUp) console.log(`hoist already up on :${HOIST_PORT}`);
  else {
    const hp = spawn("node", [join(EVALS_DIR, "vast-hoist.mjs")], {
      env: { ...process.env, VAST_UPSTREAM_OPENAI_BASE_URL: state.VAST_UPSTREAM_OPENAI_BASE_URL, HOIST_PORT: String(HOIST_PORT) },
      detached: true, stdio: "ignore",
    });
    hp.unref();
    hoistPid = hp.pid;
    console.log(`hoist up on :${HOIST_PORT} (pid ${hoistPid})`);
  }
  try {
    const alive = await fetch(`http://127.0.0.1:${SHIM_PORT}/health/liveliness`, { signal: AbortSignal.timeout(1500) });
    if (alive.ok) {
      console.log(`shim already up on :${SHIM_PORT}`);
      if (hoistPid !== state.VAST_HOIST_PID) await writeState({ ...state, VAST_HOIST_PID: hoistPid });
      return;
    }
  } catch {}
  const proc = spawn("litellm", ["--config", join(EVALS_DIR, "litellm.vast.yaml"), "--port", String(SHIM_PORT)], {
    env: { ...process.env, VAST_UPSTREAM_OPENAI_BASE_URL: `http://127.0.0.1:${HOIST_PORT}/v1`, VAST_API_KEY: state.VAST_API_KEY },
    detached: true, stdio: "ignore",
  });
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { if ((await fetch(`http://127.0.0.1:${SHIM_PORT}/health/liveliness`, { signal: AbortSignal.timeout(1500) })).ok) break; } catch {}
    if (i === 29) throw new Error("LiteLLM shim did not come up (is litellm installed? `uv tool install 'litellm[proxy]'`)");
  }
  await writeState({ ...state, VAST_SHIM_PID: proc.pid, ...(hoistPid ? { VAST_HOIST_PID: hoistPid } : {}) });
  console.log(`shim up on :${SHIM_PORT} (pid ${proc.pid})`);
}

// ── status / down ─────────────────────────────────────────────────────────────

async function status() {
  const state = await readState();
  if (!state) { console.log("no pod (evals/.vast.env absent)"); return; }
  console.log("instance:", state.VAST_INSTANCE_ID, "| upstream:", state.VAST_UPSTREAM_OPENAI_BASE_URL ?? "(provisioning)");
  try {
    const inst = (await vast("GET", `/instances/${state.VAST_INSTANCE_ID}/`)).instances;
    console.log("vast status:", inst.actual_status, "| $/hr:", inst.dph_total?.toFixed?.(3));
  } catch (e) { console.log("vast status: lookup failed —", e.message.slice(0, 120)); }
  if (state.VAST_UPSTREAM_OPENAI_BASE_URL) {
    try {
      const r = await fetch(`${state.VAST_UPSTREAM_OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${state.VAST_API_KEY}` }, signal: AbortSignal.timeout(5000) });
      console.log("vLLM:", r.ok ? `serving ${(await r.json()).data?.map((m) => m.id).join(", ")}` : `HTTP ${r.status}`);
    } catch { console.log("vLLM: unreachable"); }
    // RTT: median of 3 timed requests. Hidden behind 5-15s generation turns,
    // so <100ms is invisible; >200ms suggests preferring a closer host.
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      try { await fetch(`${state.VAST_UPSTREAM_OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${state.VAST_API_KEY}` }, signal: AbortSignal.timeout(5000) }); times.push(Date.now() - t0); } catch {}
    }
    if (times.length) {
      const rtt = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
      console.log(`RTT: ~${rtt}ms ${rtt < 100 ? "(fine — invisible behind generation)" : rtt < 200 ? "(ok — bump --qa-concurrency to compensate)" : "(high — consider a closer host next time)"}`);
    }
  }
  try {
    const r = await fetch(`http://127.0.0.1:${SHIM_PORT}/health/liveliness`, { signal: AbortSignal.timeout(1500) });
    console.log("shim:", r.ok ? `up on :${SHIM_PORT}` : `HTTP ${r.status}`);
  } catch { console.log("shim: down"); }
}

async function down() {
  const state = await readState();
  if (!state) { console.log("nothing to tear down"); return; }
  if (state.VAST_SHIM_PID) { try { process.kill(Number(state.VAST_SHIM_PID)); console.log("shim stopped"); } catch {} }
  if (state.VAST_HOIST_PID) { try { process.kill(Number(state.VAST_HOIST_PID)); console.log("hoist stopped"); } catch {} }
  try { await vast("DELETE", `/instances/${state.VAST_INSTANCE_ID}/`, {}); console.log(`instance ${state.VAST_INSTANCE_ID} destroyed`); }
  catch (e) { console.error("destroy failed (check the Vast console!):", e.message.slice(0, 200)); }
  await rm(VAST_ENV, { force: true });
}

// ── probe (6-run transport reliability — the DashScope lesson, codified) ──────

async function probe() {
  const mem = await mkdtemp(join(tmpdir(), "vast-probe-mem-"));
  await mkdir(join(mem, "p"), { recursive: true });
  await writeFile(join(mem, "p", "MEMORY.md"),
    "# p — memory index\n\n- [deploy-schedule.md](deploy-schedule.md) — deploy schedule change\n");
  await writeFile(join(mem, "p", "deploy-schedule.md"),
    "---\nname: deploy-schedule\ndescription: deploy schedule change\n---\n\nAs of 2026-05-21 deploys moved from Friday afternoons to **Wednesday mornings** (weekend incident fallout).\n");
  const server = await spawnVaultServer(mem);
  const workDir = await mkdtemp(join(tmpdir(), "vast-probe-w-"));
  let failed = false;
  try {
    for (const h of cfg.harnesses) {
      const b = resolveBackend({ provider: cfg.provider, harness: h, baseUrl: null, apiKeyEnv: null });
      let ok = 0;
      for (let i = 1; i <= 6; i++) {
        // Same QA prompt template as real cells (lib.mjs) — the probe must
        // exercise the exact prompt shape the cells will.
        const r = await drivers[h].run({
          prompt: qaVaultPrompt({ question: "what day do deploys happen?" }, "2026-08-29"),
          mcpUrl: `${server.base}/mcp/p`, model: cfg.servedName, bare: h === "claude", workDir,
          timeoutMs: 120_000, label: `probe-${h}-${i}`,
          allowedTools: h === "claude" ? VAULT_READ_TOOLS : undefined,
          ...b,
        }).catch((e) => ({ isError: true, text: String(e.message) }));
        const good = !r.isError && /wednesday/i.test(r.text);
        if (good) ok++;
        console.log(`  [${h}] run ${i}: ${good ? "OK" : "FAIL"} ${good ? "" : JSON.stringify(String(r.text)).slice(0, 80)}`);
      }
      console.log(`  ${h} via ${cfg.provider}: ${ok}/6`);
      if (ok < 6) { failed = true; console.error(`  ${h}: transport unreliable — do NOT trust cell results on this path`); }
    }
  } finally {
    server.kill();
    await rm(mem, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  console.log("probe: transport clean on all harnesses");
}

// ── dispatch ──────────────────────────────────────────────────────────────────

async function search() {
  const offers = await searchOffers();
  if (!offers.length) { console.log(`no qualifying offers <= $${cfg.maxPrice}/hr${cfg.country ? ` in "${cfg.country}"` : ""}`); return; }
  offers.slice(0, 12).forEach((o) => console.log(offerRow(o)));
  console.log(`\npick one and: node evals/vast.mjs start --offer <ID>   (prefer in-region — RTT hides behind generation)`);
}

// Print shell exports for manual claude/codex poking against the pod:
//   eval "$(node evals/vast.mjs env)"
//   claude --model qwen3.5-35b-a3b -p "which model are you?"
async function env() {
  const state = await readState();
  if (!state) { console.error("# no pod up — `vast.mjs start` first"); process.exit(1); }
  console.log(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${SHIM_PORT}`);
  console.log(`export ANTHROPIC_AUTH_TOKEN=${state.VAST_API_KEY}`);
  console.log(`export ANTHROPIC_API_KEY=`);
  console.log(`export VAST_API_KEY=${state.VAST_API_KEY}`);
  console.log(`export VAST_UPSTREAM_OPENAI_BASE_URL=${state.VAST_UPSTREAM_OPENAI_BASE_URL}`);
  console.log(`export CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192`);
}

const commands = {
  search, start, status, probe, down, env,
  // start's composable steps — resume an interrupted start with wait → shim:
  create: createPod, wait: () => waitForVllm(), shim: startShim,
};
if (!commands[cmd]) {
  console.error("usage: node evals/vast.mjs <search|start|create|wait|shim|status|probe|down|env> [flags] — see file header for the manual flow");
  process.exit(2);
}
commands[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
