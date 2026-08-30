#!/usr/bin/env node
// Per-harness smoke gate — run before any matrix work:
//
//   node evals/drivers/smoke.mjs [--harness claude,codex] [--model M] [--keep]
//
// Per harness: throwaway vault → "save fact X" (RW) → assert the fact landed on
// disk → fresh session "what is X?" → assert round-trip + parseable usage.
// Codex extras: resolves the CLI's default model from the non-JSON banner
// (killed before any tokens are spent), and pins the MCP approval override by
// probing candidates in order — the winner is written to codex-approval.json,
// which codex.mjs reads on every subsequent run.

import { spawn, execSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drivers, resolveBackend } from "./index.mjs";
import { APPROVAL_CANDIDATES } from "./codex.mjs";
import {
  cliArgs, loadDotEnv, assertBackendFlags, spawnVaultServer, seedScope,
  qaVaultPrompt, VAULT_TOOLS, VAULT_READ_TOOLS,
} from "../lib.mjs";

loadDotEnv();

const DRIVERS_DIR = dirname(fileURLToPath(import.meta.url));
const PIN_FILE = join(DRIVERS_DIR, "codex-approval.json");

const { opt, flag } = cliArgs();
const harnesses = opt("harness", "claude,codex").split(",").map((s) => s.trim());
const modelOverride = opt("model", null);
const keep = flag("keep");
// Custom backend under test — same flags (and shared validation) as run.mjs;
// per-harness base URL and key resolve from the evals/.env provider profile
// when not given explicitly.
const provider = opt("provider", "native");
const baseUrlFlag = opt("base-url", null);
const apiKeyEnvFlag = opt("api-key-env", null);
const wireApiFlag = opt("wire-api", null); // codex: null = probe responses, then chat
try { assertBackendFlags({ provider, baseUrl: baseUrlFlag, model: modelOverride }); }
catch (e) { console.error(e.message); process.exit(1); }
const backendFor = (harness) => {
  if (provider === "native") return { baseUrl: null, apiKeyEnv: null };
  const b = resolveBackend({ provider, harness, baseUrl: baseUrlFlag, apiKeyEnv: apiKeyEnvFlag });
  if (b.apiKeyEnv && !process.env[b.apiKeyEnv]) { console.error(`${b.apiKeyEnv} is not set (evals/.env)`); process.exit(1); }
  return b;
};
const TIMEOUT = 180_000;

const FACT = "the staging deploy passphrase hint is falcon-42";
const DEFAULT_MODEL = { claude: "haiku", codex: null }; // codex null = CLI default

// ── infra (server spawn + scope seeding shared via ../lib.mjs) ────────────────

async function mdFiles(dir) {
  return (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
}

// Resolve codex's default model from the non-JSON banner (printed before any
// network call); kill the process the moment the line appears — zero tokens.
function codexDefaultModel(workDir) {
  return new Promise((resolvePromise) => {
    const proc = spawn("codex", [
      "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
      "--color", "never", "-C", workDir, "-s", "read-only", "-",
    ], { cwd: workDir });
    let out = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolvePromise(null); }, 20_000);
    const scan = (d) => {
      out += d;
      const m = out.match(/^model:\s*(\S+)/m);
      if (m) { clearTimeout(timer); proc.kill("SIGKILL"); resolvePromise(m[1]); }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.on("error", () => { clearTimeout(timer); resolvePromise(null); });
    proc.on("close", () => { clearTimeout(timer); resolvePromise(null); });
    proc.stdin.write("say nothing");
    proc.stdin.end();
  });
}

// ── steps ─────────────────────────────────────────────────────────────────────

const savePrompt =
  `A session is ending. Persist this fact to your memory directory per your memory instructions, then reply "done": ${FACT}`;
// The read step uses the same QA template real cells use (lib.mjs), so the
// smoke gate exercises the exact prompt shape of the matrix.
const askPrompt = qaVaultPrompt(
  { question: "what is the staging deploy passphrase hint?" },
  new Date().toISOString().slice(0, 10));

async function pinCodexApproval(server, memoryDir, workDir, model, backend = {}) {
  for (const cand of APPROVAL_CANDIDATES) {
    const scope = `pin-${APPROVAL_CANDIDATES.indexOf(cand)}`;
    const scopeDir = await seedScope(memoryDir, scope);
    process.stdout.write(`  [codex] probing approval override: ${cand.name} ... `);
    try {
      const r = await drivers.codex.run({
        prompt: savePrompt, mcpUrl: `${server.base}/mcp/${scope}`, model,
        workDir, timeoutMs: TIMEOUT, label: `pin-${scope}`, approval: cand, ...backend,
      });
      // Success = the fact landed on disk. Individual failed MCP calls are fine
      // (the agent may probe a missing path first); approval-blocked calls never write.
      const wrote = (await mdFiles(scopeDir)).length > 0;
      if (wrote) {
        console.log(`WORKS${r.raw?.mcpFailedCalls ? ` (${r.raw.mcpFailedCalls} non-fatal failed call(s))` : ""}`);
        const pin = { name: cand.name, args: cand.args, dangerous: Boolean(cand.dangerous),
          dropSandboxFlag: Boolean(cand.dropSandboxFlag),
          codexVersion: execSync("codex --version").toString().trim(), pinnedAt: new Date().toISOString() };
        await writeFile(PIN_FILE, JSON.stringify(pin, null, 2) + "\n");
        return pin;
      }
      console.log(`no (wrote=${wrote}, failedMcpCalls=${r.raw?.mcpFailedCalls})`);
    } catch (e) {
      console.log(`no (${String(e.message ?? e).slice(0, 80)})`);
    }
  }
  return null;
}

// With a custom backend on codex, the wire protocol is unknown until probed:
// try "responses" first (the documented value), fall back to "chat". A cheap
// no-MCP call decides; the winner is used for the real steps and reported.
async function pinWireApi(backend, model, workDir) {
  for (const wa of wireApiFlag ? [wireApiFlag] : ["responses", "chat"]) {
    process.stdout.write(`  [codex] probing wire_api="${wa}" against ${provider} ... `);
    try {
      const r = await drivers.codex.run({
        prompt: "Reply with exactly the word: pong", mcpUrl: null, model,
        workDir, timeoutMs: TIMEOUT, label: `wire-${wa}`, ...backend, wireApi: wa,
      });
      if (!r.isError && /pong/i.test(r.text)) { console.log("WORKS"); return wa; }
      console.log(`no (isError=${r.isError}, text="${String(r.text).slice(0, 60)}")`);
    } catch (e) { console.log(`no (${String(e.message ?? e).slice(0, 80)})`); }
  }
  throw new Error(`codex: no wire_api variant worked against ${provider} — check base URL/key`);
}

async function smokeHarness(name, server, memoryDir, workDir) {
  const model = modelOverride ?? DEFAULT_MODEL[name];
  const driver = drivers[name];
  if (!driver) throw new Error(`unknown harness: ${name}`);
  const backend = backendFor(name);
  if (name === "codex" && backend.baseUrl)
    backend.wireApi = await pinWireApi(backend, model, workDir);
  console.log(`\n== ${name} (model: ${model ?? "CLI default"}, backend: ${provider}${backend.baseUrl ? ` ${backend.baseUrl}` : ""}) ==`);

  if (name === "codex") {
    if (!backend.baseUrl) {
      const resolved = await codexDefaultModel(workDir);
      console.log(`  [codex] default model (banner probe): ${resolved ?? "unresolved"}`);
    }
    const pin = existsSync(PIN_FILE) ? JSON.parse(await readFile(PIN_FILE, "utf8")) : null;
    if (pin) console.log(`  [codex] approval pin already exists: ${pin.name}`);
    else {
      const pinned = await pinCodexApproval(server, memoryDir, workDir, model, backend);
      if (!pinned) throw new Error("codex: no approval override candidate worked — MCP tools unusable");
      if (pinned.dangerous) console.log("  ⚠ pinned override disables the codex sandbox — recorded in pin file");
    }
  }

  const scope = `smoke-${name}`;
  const scopeDir = await seedScope(memoryDir, scope);

  // 1. RW round-trip: save the fact, assert it landed on disk. One retry:
  // smoke gates plumbing, and a small model occasionally dithers and stops
  // without persisting — a second attempt separates flake from broken wiring.
  let w, files;
  for (let attempt = 1; attempt <= 2; attempt++) {
    w = await driver.run({
      prompt: savePrompt, mcpUrl: `${server.base}/mcp/${scope}`, model,
      allowedTools: name === "claude" ? VAULT_TOOLS : undefined,
      workDir, timeoutMs: TIMEOUT, label: `smoke-${name}-write-a${attempt}`, ...backend,
    });
    files = await mdFiles(scopeDir);
    if (files.length) break;
    if (attempt === 1) console.log(`  write attempt 1: nothing persisted (model dithered?) — retrying once`);
  }
  const onDisk = (await Promise.all(files.map((f) => readFile(join(scopeDir, f), "utf8"))))
    .some((t) => /falcon-42/i.test(t));
  console.log(`  write: ${files.length} file(s), fact on disk: ${onDisk} (${w.numTurns} turns, ${w.durationMs}ms)`);
  if (!onDisk) throw new Error(`${name}: fact not persisted to vault. Answer was: ${w.text.slice(0, 200)}`);

  // 2. Fresh-session read: answer must contain the fact.
  const r = await driver.run({
    prompt: askPrompt, mcpUrl: `${server.base}/mcp/${scope}`, model,
    allowedTools: name === "claude" ? VAULT_READ_TOOLS : undefined,
    workDir, timeoutMs: TIMEOUT, label: `smoke-${name}-read`, ...backend,
  });
  const answered = /falcon-42/i.test(r.text);
  console.log(`  read: answered=${answered} — "${r.text.slice(0, 100).replace(/\n/g, " ")}"`);
  if (!answered) throw new Error(`${name}: round-trip failed. Answer: ${r.text.slice(0, 200)}`);

  // 3. Contract fields parse.
  for (const [k, v] of Object.entries({ usage: r.usage, models: r.models, durationMs: r.durationMs })) {
    if (v == null) throw new Error(`${name}: contract field missing: ${k}`);
  }
  if (typeof r.usage.output_tokens !== "number" || !(r.usage.output_tokens > 0))
    throw new Error(`${name}: usage.output_tokens not parsed: ${JSON.stringify(r.usage)}`);
  console.log(`  contract: usage ok (out=${r.usage.output_tokens}, cache_read=${r.usage.cache_read_input_tokens}), models=${r.models.join(",")}, costUsd=${r.costUsd}`);
  if (name === "codex" && backend.wireApi)
    console.log(`  [codex] pass --wire-api ${backend.wireApi} to run.mjs for this provider`);
  console.log(`  ${name}: PASS`);
}

// ── main ──────────────────────────────────────────────────────────────────────

const memoryDir = await mkdtemp(join(tmpdir(), "vault-smoke-mem-"));
const workDir = await mkdtemp(join(tmpdir(), "vault-smoke-work-"));
const server = await spawnVaultServer(memoryDir);
console.log(`vault server up, memory at ${memoryDir}`);

let failed = false;
try {
  for (const h of harnesses) {
    try { await smokeHarness(h, server, memoryDir, workDir); }
    catch (e) { failed = true; console.error(`  ${h}: FAIL — ${e.message}`); }
  }
} finally {
  server.kill();
  if (keep) console.log(`kept: ${memoryDir}`);
  else { await rm(memoryDir, { recursive: true, force: true }); await rm(workDir, { recursive: true, force: true }); }
}
process.exit(failed ? 1 : 0);
