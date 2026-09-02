#!/usr/bin/env node
// MemoryArena eval runner — interdependent multi-session tasks (see lib.mjs).
//
//   node evals_memory_arena/run.mjs [--suite math|phys] [--harness claude|codex]
//        [--memory vault] [--model sonnet] [--judge-model haiku] [--baselines]
//        [--papers N] [--paper id|1-based-index] [--no-cache] [--keep-vault]
//        [--bare] [--only judge]
//        [--provider tag --base-url URL --api-key-env NAME [--wire-api ...]]
//
// Structure vs the LoCoMo runner (evals/run.mjs): there is no separate ingest
// corpus — subtasks are the sessions. Per paper, subtasks run STRICTLY in
// order; after each vault-arm subtask a distill session (write access) persists
// the experience, mirroring MemoryArena's memory_client.add(). Parallelism is
// across papers, never within one. Baselines (--baselines): closed_book (their
// "none") and full_context (their "long_context" — the arm's own prior
// answers pasted in). Judge: their math-equivalence check, hard-pinned to the
// claude driver like the LoCoMo suite — the instrument stays constant.
//
// Results land in evals_memory_arena/results/<harness>-<memory>-<model>/ —
// same cell naming as evals/, separate results tree. Per-unit cache +
// per-subtask vault snapshots make crashed runs resume.
//
// Zero dependencies. Node >= 18.

import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drivers, resolveBackend } from "../evals/drivers/index.mjs";
import { approvalPin } from "../evals/drivers/codex.mjs";
import {
  REPO_DIR, cliArgs, loadDotEnv, assertBackendFlags,
  spawnVaultServer, seedScope, VAULT_TOOLS, VAULT_READ_TOOLS, healthCheck,
} from "../evals/lib.mjs";
import {
  ARENA_DIR, ARENA_PROMPTS_VERSION, loadArenaSuite,
  qaVaultArenaPrompt, qaClosedBookArenaPrompt, qaFullContextArenaPrompt,
  memoryEntry, distillArenaPrompt, arenaJudgePrompt, arenaMetrics,
} from "./lib.mjs";

loadDotEnv(); // evals/.env — shared provider profiles; real env vars win

const RESULTS_DIR = join(ARENA_DIR, "results");

// ── Config ────────────────────────────────────────────────────────────────────

const { opt, flag } = cliArgs();

const cfg = {
  suite: opt("suite", "math"),
  harness: opt("harness", "claude"),
  memory: opt("memory", "vault"),
  model: opt("model", null),
  provider: opt("provider", "native"),
  baseUrl: opt("base-url", null),
  apiKeyEnv: opt("api-key-env", null),
  wireApi: opt("wire-api", "responses"),
  judgeModel: opt("judge-model", "haiku"),
  baselines: flag("baselines"),
  noCache: flag("no-cache"),
  keepVault: flag("keep-vault"),
  bare: flag("bare"),
  only: opt("only", null), // "judge" = re-judge cached answers, no QA/server

  papers: opt("papers", null) ? Number(opt("papers", null)) : null, // first N papers
  paper: opt("paper", null),  // one paper: id or 1-based index
  paperConcurrency: Number(opt("paper-concurrency", 3)),
  qaTimeoutMs: Number(opt("qa-timeout", 420_000)),      // proof-grade reasoning is slow
  distillTimeoutMs: Number(opt("distill-timeout", 300_000)),
  judgeTimeoutMs: Number(opt("judge-timeout", 120_000)),
};

if (!drivers[cfg.harness]) throw new Error(`unknown --harness ${cfg.harness} (have: ${Object.keys(drivers).join(", ")})`);
if (cfg.memory !== "vault") throw new Error(`--memory ${cfg.memory} not implemented yet (only "vault")`);
if (cfg.only && cfg.only !== "judge") throw new Error(`--only ${cfg.only}: expected "judge"`);
assertBackendFlags(cfg);
if (cfg.harness === "claude") cfg.model ??= "sonnet";
Object.assign(cfg, resolveBackend({ provider: cfg.provider, harness: cfg.harness, baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv }));
if (cfg.apiKeyEnv && !process.env[cfg.apiKeyEnv])
  throw new Error(`--api-key-env ${cfg.apiKeyEnv}: that env var is not set`);

const harnessTag = cfg.harness === "claude" ? "" : `-${cfg.harness}`;
const modelTag = (cfg.model ?? "default").replace(/[^a-zA-Z0-9._-]/g, "_");
const providerTag = cfg.provider === "native" ? "" : `-${cfg.provider.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
const cellTag = `${cfg.harness}-${cfg.memory}-${modelTag}${providerTag}`;
const CELL_DIR = join(RESULTS_DIR, cellTag);
const paperSel = cfg.paper ? `-p${String(cfg.paper).replace(/[^a-zA-Z0-9._-]/g, "_")}` : cfg.papers ? `-n${cfg.papers}` : "";
const configTag = `${cfg.suite}${paperSel}${harnessTag}-${modelTag}${providerTag}${cfg.bare ? "-bare" : ""}`;
// Hash excludes the paper subset: a --papers 2 smoke and the full run share
// cache entries for the papers they have in common.
const configHash = createHash("sha256")
  .update(JSON.stringify({ arena: cfg.suite, model: cfg.model, judge: cfg.judgeModel, bare: cfg.bare, ARENA_PROMPTS_VERSION,
    ...(cfg.harness !== "claude" ? { harness: cfg.harness } : {}),
    ...(cfg.memory !== "vault" ? { memory: cfg.memory } : {}),
    ...(cfg.provider !== "native" ? { provider: cfg.provider, baseUrl: cfg.baseUrl } : {}) }))
  .digest("hex").slice(0, 12);
const CACHE_DIR = join(CELL_DIR, ".cache", configHash);
const RESULTS_FILE = join(CELL_DIR, `${configTag}.jsonl`);

// ── Agent runners (same discipline as evals/run.mjs) ──────────────────────────

let workDir;

const runAgent = (o) => drivers[cfg.harness].run({
  bare: cfg.bare, workDir,
  baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv, wireApi: cfg.wireApi,
  ...o,
});
const judgeEnv = { ...process.env };
delete judgeEnv.ANTHROPIC_BASE_URL;
delete judgeEnv.ANTHROPIC_AUTH_TOKEN;
const runJudge = (o) => drivers.claude.run({ bare: false, workDir, env: judgeEnv, ...o });

const apiFail = /^API Error|spend limit|usage limit/i;

async function cached(unitId, compute) {
  const file = join(CACHE_DIR, `${unitId}.json`);
  if (!cfg.noCache && existsSync(file)) return { ...JSON.parse(await readFile(file, "utf8")), fromCache: true };
  const value = await compute();
  await writeFile(file, JSON.stringify(value));
  return value;
}

async function judgeAnswer(paper, sub, i, system, answer) {
  const j = await runJudge({
    prompt: arenaJudgePrompt(sub, answer),
    mcpUrl: null, allowedTools: [],
    model: cfg.judgeModel,
    timeoutMs: cfg.judgeTimeoutMs,
    label: `judge-${paper.id}-q${i}-${system}`,
  });
  if (j.isError || apiFail.test(j.text ?? ""))
    throw new Error(`judge call failed: ${String(j.text).slice(0, 150)}`);
  let verdict = { verdict: "unparseable", reason: j.text.slice(0, 200) };
  const m = j.text.match(/\{[\s\S]*\}/);
  if (m) {
    try { verdict = JSON.parse(m[0]); }
    catch {
      // Math answers push the judge into LaTeX-laden reasons whose backslash
      // escapes (\nu, \overline) are invalid JSON — salvage the verdict token
      // instead of discarding the judgement.
      const v = m[0].match(/"verdict"\s*:\s*"(correct|incorrect)"/);
      const r = m[0].match(/"reason"\s*:\s*"([\s\S]*)"/);
      if (v) verdict = { verdict: v[1], reason: r?.[1].slice(0, 300) ?? "(reason had invalid JSON escapes)" };
    }
  }
  return { verdict: verdict.verdict, reason: verdict.reason, judgeCostUsd: j.costUsd, judgeModels: j.models };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const out = [];
const emit = async (rec) => { out.push(rec); await appendFile(RESULTS_FILE, JSON.stringify(rec) + "\n"); };
const git = (cmd) => { try { return execSync(cmd, { cwd: REPO_DIR }).toString().trim(); } catch { return "unknown"; } };
const judgeOnly = cfg.only === "judge";

// One paper end to end: subtasks strictly in order, all arms interleaved at
// each position so no arm ever sees material from a later subtask.
async function runPaper(paper, server, memoryDir, systems, tally, progress) {
  const n = paper.subtasks.length;
  const scopeDir = memoryDir ? join(memoryDir, paper.id) : null;
  const snapAt = (i) => join(CACHE_DIR, `vault-${paper.id}-q${i}.tgz`);
  const hasVault = systems.includes("vault") && !judgeOnly;

  // Vault resume: restore the newest snapshot; subtasks at or before it skip
  // their distill step (their QA/judge records come from the unit cache).
  let restored = -1;
  if (hasVault) {
    if (!cfg.noCache)
      for (let i = n - 1; i >= 0; i--)
        if (existsSync(snapAt(i))) { restored = i; break; }
    if (restored >= 0) {
      await mkdir(scopeDir, { recursive: true });
      execSync(`tar -xzf "${snapAt(restored)}" -C "${scopeDir}"`);
      console.log(`[vault] ${paper.id}: restored snapshot through subtask ${restored + 1}/${n}`);
    } else {
      await seedScope(memoryDir, paper.id);
    }
  }

  const fcEntries = []; // full_context arm's own accumulated task+solution entries
  for (let i = 0; i < n; i++) {
    const sub = paper.subtasks[i];
    for (const system of systems) {
      const unitId = `${paper.id}-q${i}-${system}`;
      let rec;
      try {
        if (judgeOnly) {
          const file = join(CACHE_DIR, `${unitId}.json`);
          if (!existsSync(file))
            throw new Error("no cached answer for this unit — run the suite (without --only judge) first");
          const prev = JSON.parse(await readFile(file, "utf8"));
          rec = { ...prev, ...(await judgeAnswer(paper, sub, i, system, prev.answer)) };
          await writeFile(file, JSON.stringify(rec));
        } else {
          rec = await cached(unitId, async () => {
            const a = await runAgent({
              prompt:
                system === "vault" ? qaVaultArenaPrompt(sub) :
                system === "closed_book" ? qaClosedBookArenaPrompt(sub) :
                qaFullContextArenaPrompt(sub, fcEntries),
              mcpUrl: system === "vault" ? `${server.base}/mcp/${paper.id}` : null,
              allowedTools: system === "vault" ? VAULT_READ_TOOLS : [], // QA is read-only; distill writes
              model: cfg.model,
              timeoutMs: cfg.qaTimeoutMs,
              label: `qa-${paper.id}-q${i}-${system}`,
            });
            if (a.isError || !String(a.text ?? "").trim() || apiFail.test(a.text ?? ""))
              throw new Error(`qa call failed: ${a.isError ? String(a.text).slice(0, 150) : "empty answer"}`);
            return {
              paper: paper.id, idx: i, system, question: sub.question, gold: sub.gold,
              answer: a.text, ...(await judgeAnswer(paper, sub, i, system, a.text)),
              qaTurns: a.numTurns, qaCostUsd: a.costUsd, qaUsage: a.usage, qaModels: a.models, qaDurationMs: a.durationMs,
            };
          });
        }
      } catch (e) {
        rec = { paper: paper.id, idx: i, system, question: sub.question, gold: sub.gold, answer: null, verdict: "error", reason: String(e).slice(0, 300) };
      }
      await emit({ type: "result", ...rec });
      tally[system] ??= { correct: 0, total: 0, errors: 0 };
      tally[system].total++;
      if (rec.verdict === "correct") tally[system].correct++;
      if (rec.verdict === "error") tally[system].errors++;
      progress.done++;
      console.log(`[qa ${progress.done}/${progress.total}] ${paper.id} q${i + 1}/${n} ${system}: ${rec.verdict}${rec.fromCache ? " (cached)" : ""}`);

      // full_context accumulates its OWN answers (their long_context memory);
      // an errored subtask contributes nothing, like a failed memory add.
      if (system === "full_context" && rec.answer)
        fcEntries.push(memoryEntry(sub, rec.answer));

      // A vault-arm error (QA or judge, usually transient) aborts the paper:
      // continuing would leave a permanent hole in the memory chain, and a
      // snapshot here would make resume skip this subtask's distill forever.
      // A rerun resumes from the last good snapshot and retries.
      if (system === "vault" && !judgeOnly && rec.verdict === "error")
        throw new Error(`vault arm broke at q${i}: ${rec.reason}`);

      // Vault distill — the memory write for this subtask, mirroring
      // memory_client.add(). Skipped for positions already inside the restored
      // snapshot; the snapshot lands only after a successful distill, so a
      // failed one (which aborts the paper) is retried on the next run.
      if (system === "vault" && hasVault && i > restored) {
        const d = await runAgent({
          prompt: distillArenaPrompt(sub, rec.answer),
          mcpUrl: `${server.base}/mcp/${paper.id}`,
          allowedTools: VAULT_TOOLS,
          model: cfg.model,
          timeoutMs: cfg.distillTimeoutMs,
          label: `distill-${paper.id}-q${i}`,
        });
        if (d.isError)
          throw new Error(`distill ${paper.id} q${i} failed: ${String(d.text).slice(0, 300)}`);
        await emit({ type: "distill", paper: paper.id, idx: i, turns: d.numTurns, costUsd: d.costUsd, usage: d.usage, models: d.models, durationMs: d.durationMs });
        execSync(`tar -czf "${snapAt(i)}" -C "${scopeDir}" .`);
      }
    }
  }

  if (hasVault) {
    const health = await healthCheck(scopeDir, []);
    console.log(`[health] ${paper.id}: ${health.files} files, ${health.bytes}B, ${health.issues.length} issues`);
    await emit({ type: "health", paper: paper.id, ...health });
    execSync(`tar -czf "${join(CELL_DIR, `${configTag}-${paper.id}.vault.tgz`)}" -C "${scopeDir}" .`);
  }
}

async function main() {
  await mkdir(CELL_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });
  await rm(RESULTS_FILE, { force: true });
  workDir = await mkdtemp(join(tmpdir(), "arena-eval-work-"));

  if (cfg.baseUrl && !judgeOnly) {
    try { await fetch(cfg.baseUrl, { signal: AbortSignal.timeout(5000) }); }
    catch (e) {
      if (e?.cause?.code === "ECONNREFUSED" || e?.name === "TimeoutError")
        throw new Error(`backend ${cfg.baseUrl} unreachable — if this is a local shim, start it first (see evals/.env)`);
    }
  }

  const suite = await loadArenaSuite(cfg.suite);
  if (cfg.paper) {
    suite.papers = suite.papers.filter((p, i) => String(i + 1) === cfg.paper || p.id === cfg.paper);
    if (!suite.papers.length) throw new Error(`--paper ${cfg.paper} matched nothing`);
  } else if (cfg.papers) {
    suite.papers = suite.papers.slice(0, cfg.papers);
  }

  const codexPin = cfg.harness === "codex" && !judgeOnly ? await approvalPin() : null;
  const contamination = [
    cfg.bare ? "QA bare mode (clean room)" : "subscription mode: global ~/.claude/CLAUDE.md auto-loads into eval agents",
    "judge: always claude subscription mode (non-bare), custom-backend env scrubbed",
    "judge: math-equivalence prompt ported from MemoryArena's MathEnvironment.judge (their env judged with gpt-5-mini; ours is the pinned claude judge)",
    ...(cfg.provider !== "native" ? [`QA model served by ${cfg.provider} (${cfg.baseUrl})`] : []),
    ...(cfg.harness === "codex" ? [
      "codex: --ignore-user-config clean room (auth from CODEX_HOME)",
      "codex: shell tool active in read-only sandbox with full-disk reads; each call gets a private empty cwd, but disk-wide exploration is a residual risk",
    ] : []),
    ...(codexPin?.dangerous ? ["codex: MCP approval pin DISABLES the codex sandbox (--dangerously-bypass-approvals-and-sandbox)"] : []),
  ].join("; ");
  await emit({
    type: "provenance",
    benchmark: "MemoryArena (arXiv 2602.16313), formal_reasoning split via HF ZexueHe/memoryarena",
    suite: cfg.suite,
    configHash,
    promptsVersion: ARENA_PROMPTS_VERSION,
    harness: cfg.harness,
    memory: cfg.memory,
    cell: cellTag,
    model: cfg.model,
    provider: cfg.provider,
    ...(cfg.provider !== "native" ? { baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv, wireApi: cfg.wireApi } : {}),
    judgeModel: cfg.judgeModel,
    papers: suite.papers.length,
    qaReadTools: VAULT_READ_TOOLS,
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
    memoryDir = await mkdtemp(join(tmpdir(), "arena-eval-mem-"));
    server = await spawnVaultServer(memoryDir);
    console.log(`server on :${server.port}, vault at ${memoryDir}`);
  }

  try {
    const systems = ["vault", ...(cfg.baselines ? ["closed_book", "full_context"] : [])];
    const tally = {};
    const progress = { done: 0, total: suite.papers.reduce((a, p) => a + p.subtasks.length, 0) * systems.length };

    // Worker pool over papers; each paper is internally sequential. A paper
    // that dies (e.g. failed distill) doesn't kill the run — its remaining
    // subtasks are simply absent and analyze reports the hole.
    let next = 0;
    const worker = async () => {
      while (next < suite.papers.length) {
        const paper = suite.papers[next++];
        try {
          await runPaper(paper, server, memoryDir, systems, tally, progress);
        } catch (e) {
          console.error(`[paper ${paper.id}] aborted: ${String(e).slice(0, 300)}`);
          await emit({ type: "paper_error", paper: paper.id, reason: String(e).slice(0, 300) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, cfg.paperConcurrency) }, worker));

    const metrics = arenaMetrics(out.filter((r) => r.type === "result"));
    await emit({ type: "summary", tally, metrics, date: new Date().toISOString() });
    console.log("\n== summary ==");
    for (const [system, m] of Object.entries(metrics))
      console.log(`${system.padEnd(13)} progress ${(100 * m.progressScore).toFixed(1)}%   task-success ${(100 * m.taskSuccess).toFixed(1)}%   subtasks ${m.correct}/${m.subtasks}${m.errors ? `   (${m.errors} errors)` : ""}`);
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
