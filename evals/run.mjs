#!/usr/bin/env node
// Memory Vault eval harness — Stage 0+.
//
//   node evals/run.mjs [--suite micro] [--harness claude|codex] [--memory vault]
//                      [--model sonnet] [--judge-model haiku] [--baselines]
//                      [--no-cache] [--keep-vault] [--bare] [--only health|judge]
//                      [--provider dashscope --base-url URL --api-key-env NAME
//                       [--wire-api responses|chat]]
//
// --only health  ingest (cache-resumable) + health checks + vault snapshots,
//                no QA/judge. --only judge re-runs the judge over this
//                config's cached answers (no server, no QA calls) — e.g. after
//                a flaky judge run — and rewrites verdicts in cache + results.
//
// Harness drivers live in evals/drivers/ (one file per CLI, shared contract).
// Judge always runs on the claude driver regardless of --harness. Run
// `node evals/drivers/smoke.mjs` once per new harness before matrix work.
//
// Results land in evals/results/<harness>-<memory>-<model>/ — one folder per
// matrix cell (e.g. claude-vault-sonnet/), each with its own .cache/.
//
// One run: spawn server.mjs on a temp MEMORY_DIR → ingest each conversation's
// sessions in order via headless `claude -p` with only the vault MCP tools →
// answer each question in a fresh session with vault access only → judge
// against gold → emit results JSONL + deterministic vault-health checks +
// a vault snapshot. Baselines (--baselines): closed-book and full-context
// with the same QA prompt shape, same judge.
//
// Design rules (see docs: "Memory Vault — Eval Execution Plan"):
//  - The harness prompt stays thin: the ritual under test is the server's
//    own MCP instructions, never duplicated here.
//  - Fresh context per question; the vault is the only channel.
//  - Provenance header is record #1 of every JSONL.
//  - Per-unit cache under results/.cache/<config>/ — ingest snapshots and
//    answer+verdict records — so crashed or re-judged runs resume.
//  - Subscription mode (default) still auto-loads the global ~/.claude/CLAUDE.md
//    (contamination — recorded in provenance). --bare is the clean room but
//    requires ANTHROPIC_API_KEY.
//
// Zero dependencies. Node >= 18.

import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm, appendFile } from "node:fs/promises";
import { drivers, resolveBackend } from "./drivers/index.mjs";
import { approvalPin } from "./drivers/codex.mjs";
import {
  EVALS_DIR, REPO_DIR, cliArgs, loadDotEnv, assertBackendFlags,
  spawnVaultServer, seedScope, VAULT_TOOLS, VAULT_READ_TOOLS,
  PROMPTS_VERSION, ingestPrompt, qaVaultPrompt, qaClosedBookPrompt,
  qaFullContextPrompt, judgePrompt, healthCheck,
} from "./lib.mjs";

loadDotEnv(); // evals/.env — endpoints/keys per provider; real env vars win
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESULTS_DIR = join(EVALS_DIR, "results");

// ── Config ────────────────────────────────────────────────────────────────────

const { opt, flag } = cliArgs();

const cfg = {
  suite: opt("suite", "micro"),
  harness: opt("harness", "claude"), // QA/ingest harness; judge always runs on claude
  memory: opt("memory", "vault"),    // memory system under test: vault | native (native TBD)
  // Model aliases are harness-specific: "sonnet" only means something to claude.
  // Other harnesses default to their CLI's own default model (null = omit -m).
  model: opt("model", null),
  // Backend the QA/ingest model is served from. "native" = the harness's own
  // account (subscription / CODEX_HOME auth). Anything else needs --base-url:
  // claude gets it as ANTHROPIC_BASE_URL, codex as a model_providers entry.
  // The judge is never routed through a custom backend.
  provider: opt("provider", "native"),
  baseUrl: opt("base-url", null),
  apiKeyEnv: opt("api-key-env", null), // env VAR NAME holding the key — value never stored
  wireApi: opt("wire-api", "responses"), // codex custom-provider wire protocol
  judgeModel: opt("judge-model", "haiku"),
  baselines: flag("baselines"),
  noCache: flag("no-cache"),
  keepVault: flag("keep-vault"),
  bare: flag("bare"),
  only: opt("only", null), // null = full run; "health" = ingest+health only; "judge" = re-judge cached answers

  conv: opt("conv", null), // run a single conversation: 1-based index or id
  qaConcurrency: Number(opt("qa-concurrency", 4)),
  ingestTimeoutMs: Number(opt("ingest-timeout", 300_000)),
  qaTimeoutMs: Number(opt("qa-timeout", 180_000)),
  judgeTimeoutMs: Number(opt("judge-timeout", 120_000)),
};

if (!drivers[cfg.harness]) throw new Error(`unknown --harness ${cfg.harness} (have: ${Object.keys(drivers).join(", ")})`);
if (cfg.memory !== "vault") throw new Error(`--memory ${cfg.memory} not implemented yet (only "vault")`);
if (cfg.only && !["health", "judge"].includes(cfg.only))
  throw new Error(`--only ${cfg.only}: expected "health" or "judge"`);
// Backend flag validation is shared with smoke.mjs (lib.mjs). It must run
// before the claude alias default below, so `--provider dashscope` can't
// silently send "sonnet" to a backend that has no such model.
assertBackendFlags(cfg);
if (cfg.harness === "claude") cfg.model ??= "sonnet";
// Fill baseUrl/apiKeyEnv from the evals/.env provider profile when not given
// explicitly (throws if the provider has no URL for this harness's wire format).
Object.assign(cfg, resolveBackend({ provider: cfg.provider, harness: cfg.harness, baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv }));
if (cfg.apiKeyEnv && !process.env[cfg.apiKeyEnv])
  throw new Error(`--api-key-env ${cfg.apiKeyEnv}: that env var is not set`);

// One folder per matrix cell — <harness>-<memory>-<model>/ — holding that
// cell's results JSONL, vault snapshots, and its own resume cache. Deleting a
// cell folder cleanly forgets the run.
const harnessTag = cfg.harness === "claude" ? "" : `-${cfg.harness}`;
const modelTag = (cfg.model ?? "default").replace(/[^a-zA-Z0-9._-]/g, "_");
const providerTag = cfg.provider === "native" ? "" : `-${cfg.provider.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
const cellTag = `${cfg.harness}-${cfg.memory}-${modelTag}${providerTag}`;
const CELL_DIR = join(RESULTS_DIR, cellTag);
const configTag = `${cfg.suite}${cfg.conv ? `-c${cfg.conv}` : ""}${harnessTag}-${modelTag}${providerTag}${cfg.bare ? "-bare" : ""}`;
const configHash = createHash("sha256")
  .update(JSON.stringify({ suite: cfg.suite, model: cfg.model, judge: cfg.judgeModel, bare: cfg.bare, PROMPTS_VERSION,
    ...(cfg.harness !== "claude" ? { harness: cfg.harness } : {}),
    ...(cfg.memory !== "vault" ? { memory: cfg.memory } : {}),
    ...(cfg.provider !== "native" ? { provider: cfg.provider, baseUrl: cfg.baseUrl } : {}) }))
  .digest("hex").slice(0, 12);
const CACHE_DIR = join(CELL_DIR, ".cache", configHash);
const RESULTS_FILE = join(CELL_DIR, `${configTag}.jsonl`);

// ── Suite loading ─────────────────────────────────────────────────────────────

async function loadSuite(name) {
  if (name === "micro") {
    const s = JSON.parse(await readFile(join(EVALS_DIR, "micro", "sessions.json"), "utf8"));
    const q = JSON.parse(await readFile(join(EVALS_DIR, "micro", "questions.json"), "utf8"));
    return { name, conversations: s.conversations, questions: q.questions };
  }
  if (name === "locomo") {
    const file = join(EVALS_DIR, "datasets", "locomo10.json");
    if (!existsSync(file)) {
      await mkdir(dirname(file), { recursive: true });
      const res = await fetch("https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json");
      if (!res.ok) throw new Error(`locomo download failed: HTTP ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
    }
    const data = JSON.parse(await readFile(file, "utf8"));
    const CAT = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
    const conversations = [], questions = [];
    data.forEach((sample, i) => {
      const c = sample.conversation;
      const id = sample.sample_id ?? `conv-${i + 1}`;
      const sessions = [];
      for (let n = 1; c[`session_${n}`]; n++) {
        sessions.push({
          date: c[`session_${n}_date_time`],
          transcript: c[`session_${n}`].map((t) => {
            const photo = t.blip_caption ? ` [shares a photo: ${t.blip_caption}]` : "";
            return `${t.speaker}:${photo} ${t.text ?? ""}`.trimEnd();
          }),
        });
      }
      conversations.push({ id, sessions });
      sample.qa.forEach((qa, j) => questions.push({
        id: `${id}-q${j}`,
        conv: id,
        category: CAT[qa.category] ?? `cat-${qa.category}`,
        question: qa.question,
        // Category 5 is adversarial/unanswerable — the gold sentinel routes it
        // through the judge's abstention rule; the dataset's adversarial_answer
        // is the trap, not the answer.
        gold: qa.category === 5 ? "NOT_IN_MEMORY" : String(qa.answer),
      }));
    });
    return { name, conversations, questions };
  }
  throw new Error(`unknown suite: ${name}`);
}

// ── Headless agent runners (per-harness drivers in ./drivers/) ────────────────

let workDir; // sterile cwd shared by all calls — no project CLAUDE.md, no .mcp.json

// QA + ingest go through the selected harness, routed to --base-url when set;
// the judge is the measurement instrument and is held constant across cells:
// always the claude driver, always subscription auth (never --bare, so a bare
// QA run can't silently move judging onto API billing), env scrubbed of any
// custom-backend routing even if the user exported it shell-wide.
const runAgent = (o) => drivers[cfg.harness].run({
  bare: cfg.bare, workDir,
  baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv, wireApi: cfg.wireApi,
  ...o,
});
const judgeEnv = { ...process.env };
delete judgeEnv.ANTHROPIC_BASE_URL;
delete judgeEnv.ANTHROPIC_AUTH_TOKEN;
const runJudge = (o) => drivers.claude.run({ bare: false, workDir, env: judgeEnv, ...o });

// Prompts (versioned via PROMPTS_VERSION) live in lib.mjs so smoke and the
// vast probe exercise the exact templates the cells use.

// ── Cache ─────────────────────────────────────────────────────────────────────

async function cached(unitId, compute) {
  const file = join(CACHE_DIR, `${unitId}.json`);
  if (!cfg.noCache && existsSync(file)) return { ...JSON.parse(await readFile(file, "utf8")), fromCache: true };
  const value = await compute();
  await writeFile(file, JSON.stringify(value));
  return value;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const out = [];
const emit = async (rec) => { out.push(rec); await appendFile(RESULTS_FILE, JSON.stringify(rec) + "\n"); };

const git = (cmd) => { try { return execSync(cmd, { cwd: REPO_DIR }).toString().trim(); } catch { return "unknown"; } };

// --only judge never talks to the QA backend or the vault server — it re-runs
// the judge (always the claude driver) over this config's cached answers.
const judgeOnly = cfg.only === "judge";

// One QA call for a unit: prompt shape by system, vault access only for "vault".
const askQA = (q, system, conv, server, today) => runAgent({
  prompt:
    system === "vault" ? qaVaultPrompt(q, today) :
    system === "closed_book" ? qaClosedBookPrompt(q, today) :
    qaFullContextPrompt(q, today, conv),
  mcpUrl: system === "vault" ? `${server.base}/mcp/${q.conv}` : null,
  allowedTools: system === "vault" ? VAULT_READ_TOOLS : [], // QA is read-only
  model: cfg.model,
  timeoutMs: cfg.qaTimeoutMs,
  label: `qa-${q.id}-${system}`,
});

// Rate-limit/API/spend-limit failures come back as exit-0 "answers" — treat as
// errors (thrown = not cached) so they're retried, never judged.
const apiFail = /^API Error|spend limit|usage limit/i;

// Judge one answer against gold — the standalone half of a unit, so --only
// judge can re-run it over cached answers without re-running QA.
async function judgeAnswer(q, system, answer) {
  const j = await runJudge({
    prompt: judgePrompt(q, answer),
    mcpUrl: null, allowedTools: [],
    model: cfg.judgeModel,
    timeoutMs: cfg.judgeTimeoutMs,
    label: `judge-${q.id}-${system}`,
  });
  if (j.isError || apiFail.test(j.text ?? ""))
    throw new Error(`judge call failed: ${String(j.text).slice(0, 150)}`);
  let verdict = { verdict: "unparseable", reason: j.text.slice(0, 200) };
  const m = j.text.match(/\{[\s\S]*\}/);
  if (m) { try { verdict = JSON.parse(m[0]); } catch {} }
  return { verdict: verdict.verdict, reason: verdict.reason, judgeCostUsd: j.costUsd, judgeModels: j.models };
}

async function main() {
  await mkdir(CELL_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });
  await rm(RESULTS_FILE, { force: true }); // one file per config; rerun replaces it
  workDir = await mkdtemp(join(tmpdir(), "vault-eval-work-"));

  // Fail fast if the backend endpoint is unreachable (e.g. the local LiteLLM
  // shim isn't running) instead of erroring per-call mid-run.
  if (cfg.baseUrl && !judgeOnly) {
    try { await fetch(cfg.baseUrl, { signal: AbortSignal.timeout(5000) }); }
    catch (e) {
      if (e?.cause?.code === "ECONNREFUSED" || e?.name === "TimeoutError")
        throw new Error(`backend ${cfg.baseUrl} unreachable — if this is a local shim, start it first (see evals/.env)`);
    }
  }

  const suite = await loadSuite(cfg.suite);
  if (cfg.conv) {
    suite.conversations = suite.conversations.filter((c, i) => String(i + 1) === cfg.conv || c.id === cfg.conv);
    if (!suite.conversations.length) throw new Error(`--conv ${cfg.conv} matched nothing`);
    const ids = new Set(suite.conversations.map((c) => c.id));
    suite.questions = suite.questions.filter((q) => ids.has(q.conv));
  }
  const today = new Date().toISOString().slice(0, 10);

  const codexPin = cfg.harness === "codex" && !judgeOnly ? await approvalPin() : null;
  const contamination = [
    cfg.bare ? "QA bare mode (clean room)" : "subscription mode: global ~/.claude/CLAUDE.md auto-loads into eval agents",
    "judge: always claude subscription mode (non-bare), custom-backend env scrubbed",
    ...(cfg.provider !== "native" ? [`QA model served by ${cfg.provider} (${cfg.baseUrl})`] : []),
    ...(cfg.harness === "codex" ? [
      "codex: --ignore-user-config clean room (auth from CODEX_HOME)",
      "codex: shell tool active in read-only sandbox with full-disk reads; each call gets a private empty cwd, but disk-wide exploration is a residual risk",
    ] : []),
    ...(codexPin?.dangerous ? ["codex: MCP approval pin DISABLES the codex sandbox (--dangerously-bypass-approvals-and-sandbox)"] : []),
  ].join("; ");
  await emit({
    type: "provenance",
    suite: cfg.suite,
    configHash,
    promptsVersion: PROMPTS_VERSION,
    harness: cfg.harness,
    memory: cfg.memory,
    cell: cellTag,
    model: cfg.model,
    provider: cfg.provider,
    ...(cfg.provider !== "native" ? { baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv, wireApi: cfg.wireApi } : {}),
    judgeModel: cfg.judgeModel,
    qaReadTools: VAULT_READ_TOOLS, // locomo-c*-sonnet (Aug 19) ran view-only
    bare: cfg.bare,
    ...(cfg.only ? { only: cfg.only } : {}),
    contamination,
    ...(cfg.harness === "codex" ? { codexApprovalPin: codexPin?.name ?? "none (using default candidate)" } : {}),
    harnessGitSha: git("git rev-parse HEAD"),
    serverDirty: git("git status --porcelain server.mjs") !== "" ? "server.mjs has uncommitted changes" : "clean",
    claudeVersion: (() => { try { return execSync("claude --version").toString().trim(); } catch { return "unknown"; } })(),
    ...(cfg.harness === "codex"
      ? { codexVersion: (() => { try { return execSync("codex --version").toString().trim(); } catch { return "unknown"; } })() }
      : {}),
    node: process.version,
    date: new Date().toISOString(),
  });

  let memoryDir = null, server = null;
  if (!judgeOnly) {
    memoryDir = await mkdtemp(join(tmpdir(), "vault-eval-mem-"));
    server = await spawnVaultServer(memoryDir);
    console.log(`server on :${server.port}, vault at ${memoryDir}`);
  }

  try {
    // ── Ingest (resumable per session: snapshot the vault after each one) ──
    for (const conv of judgeOnly ? [] : suite.conversations) {
      const scopeDir = join(memoryDir, conv.id);
      const snapAt = (n) => join(CACHE_DIR, `vault-${conv.id}-s${n}.tgz`);
      let start = 0;
      if (!cfg.noCache)
        for (let n = conv.sessions.length; n >= 1; n--)
          if (existsSync(snapAt(n))) { start = n; break; }
      if (start > 0) {
        await mkdir(scopeDir, { recursive: true });
        execSync(`tar -xzf "${snapAt(start)}" -C "${scopeDir}"`);
        console.log(`[ingest] ${conv.id}: restored cache through session ${start}/${conv.sessions.length}`);
        await emit({ type: "ingest", conv: conv.id, fromCache: true, throughSession: start });
      } else {
        await seedScope(memoryDir, conv.id);
      }
      for (let i = start; i < conv.sessions.length; i++) {
        const session = conv.sessions[i];
        const r = await runAgent({
          prompt: ingestPrompt(session),
          mcpUrl: `${server.base}/mcp/${conv.id}`,
          allowedTools: VAULT_TOOLS,
          model: cfg.model,
          timeoutMs: cfg.ingestTimeoutMs,
          label: `ingest-${conv.id}-${i}`,
        });
        // Never snapshot an errored ingest — it would poison the resume cache
        // with an empty/partial vault that later runs silently restore.
        if (r.isError) {
          await emit({ type: "ingest", conv: conv.id, session: i, date: session.date, isError: true, text: String(r.text).slice(0, 300) });
          throw new Error(`ingest ${conv.id} session ${i} failed: ${String(r.text).slice(0, 300)}`);
        }
        execSync(`tar -czf "${snapAt(i + 1)}" -C "${scopeDir}" .`);
        console.log(`[ingest] ${conv.id} session ${i + 1}/${conv.sessions.length} (${session.date}): ${r.numTurns} turns, $${r.costUsd?.toFixed(4)}`);
        await emit({ type: "ingest", conv: conv.id, session: i, date: session.date, turns: r.numTurns, costUsd: r.costUsd, usage: r.usage, models: r.models, durationMs: r.durationMs, isError: r.isError });
      }
      // Health + snapshot into results/
      const health = await healthCheck(scopeDir, suite.questions.filter((q) => q.conv === conv.id));
      console.log(`[health] ${conv.id}: ${health.files} files, ${health.bytes}B, ${health.staleFacts} stale, ${health.issues.length} issues`);
      await emit({ type: "health", conv: conv.id, ...health });
      execSync(`tar -czf "${join(CELL_DIR, `${configTag}-${conv.id}.vault.tgz`)}" -C "${scopeDir}" .`);
    }

    if (cfg.only === "health") {
      console.log(`\n--only health: skipped QA/judge. results: ${RESULTS_FILE}`);
      return;
    }

    // ── QA + judge (worker pool; per-unit errors don't kill the run) ──
    const systems = ["vault", ...(cfg.baselines ? ["closed_book", "full_context"] : [])];
    const units = suite.questions.flatMap((q) => systems.map((system) => ({ q, system })));
    const tally = {};
    let next = 0, done = 0;
    const worker = async () => {
      while (next < units.length) {
        const { q, system } = units[next++];
        const conv = suite.conversations.find((c) => c.id === q.conv);
        const unitId = `${q.id}-${system}`;
        let rec;
        try {
          if (judgeOnly) {
            // Re-judge this config's cached answer, rewriting the cached record
            // so later full runs see the new verdict too.
            const file = join(CACHE_DIR, `${unitId}.json`);
            if (!existsSync(file))
              throw new Error("no cached answer for this unit — run the suite (without --only judge) first");
            const prev = JSON.parse(await readFile(file, "utf8"));
            rec = { ...prev, ...(await judgeAnswer(q, system, prev.answer)) };
            await writeFile(file, JSON.stringify(rec));
          } else {
            rec = await cached(unitId, async () => {
              const a = await askQA(q, system, conv, server, today);
              // Empty answers are errors too: codex+small models occasionally end
              // a turn without a final message event — a flake, not an answer.
              if (a.isError || !String(a.text ?? "").trim() || apiFail.test(a.text ?? ""))
                throw new Error(`qa call failed: ${a.isError ? String(a.text).slice(0, 150) : "empty answer"}`);
              return {
                id: q.id, system, category: q.category, question: q.question, gold: q.gold,
                answer: a.text, ...(await judgeAnswer(q, system, a.text)),
                qaTurns: a.numTurns, qaCostUsd: a.costUsd, qaUsage: a.usage, qaModels: a.models, qaDurationMs: a.durationMs,
              };
            });
          }
        } catch (e) {
          rec = { id: q.id, system, category: q.category, question: q.question, gold: q.gold, answer: null, verdict: "error", reason: String(e).slice(0, 300) };
        }
        await emit({ type: "result", ...rec });
        tally[system] ??= { correct: 0, total: 0, errors: 0 };
        tally[system].total++;
        if (rec.verdict === "correct") tally[system].correct++;
        if (rec.verdict === "error") tally[system].errors++;
        done++;
        console.log(`[qa ${done}/${units.length}] ${q.id} ${system}: ${rec.verdict}${rec.fromCache ? " (cached)" : ""} — ${String(rec.answer).slice(0, 80).replace(/\n/g, " ")}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, cfg.qaConcurrency) }, worker));

    await emit({ type: "summary", tally, date: new Date().toISOString() });
    console.log("\n== summary ==");
    for (const [system, t] of Object.entries(tally)) console.log(`${system}: ${t.correct}/${t.total}`);
    console.log(`results: ${RESULTS_FILE}`);
  } finally {
    server?.kill();
    if (memoryDir) {
      if (cfg.keepVault) console.log(`vault kept at ${memoryDir}`);
      else await rm(memoryDir, { recursive: true, force: true });
    }
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
