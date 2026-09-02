// MemoryArena suite library — dataset loading, versioned prompts, metrics.
//
// MemoryArena (arXiv 2602.16313, github.com/ZexueHe/MemoryArena) benchmarks
// agent memory on *interdependent multi-session agentic tasks*: each task is a
// sequence of subtasks where later subtasks build on what was learned solving
// earlier ones. Memory is the only channel across subtasks.
//
// This suite ports the two self-contained splits — formal_reasoning_math (40
// papers) and formal_reasoning_phys (20 papers), 5 sequential subtasks each,
// dataset ZexueHe/memoryarena on HuggingFace. Their "environment" for these
// splits is just an LLM equivalence judge, so no Python env server is needed;
// the interactive splits (travel/shopping/search) need their env server and a
// tool bridge — not ported yet.
//
// Arm mapping to the paper's memory systems:
//   vault        — ours: fresh session per subtask, vault MCP is the memory
//   closed_book  — their "none": each subtask cold, background only
//   full_context — their "long_context": all prior subtask+solution entries
//                  pasted into the prompt (entries from the arm's own answers)
//
// Shared infra (drivers, arg parsing, vault server lifecycle) is imported from
// ../evals — this folder holds only what differs. Zero deps. Node >= 18.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARENA_DIR = dirname(fileURLToPath(import.meta.url));
export const DATASETS_DIR = join(ARENA_DIR, "datasets");

// ── Dataset ───────────────────────────────────────────────────────────────────

const HF_DATASET = "ZexueHe/memoryarena";
const HF_CONFIGS = { math: "formal_reasoning_math", phys: "formal_reasoning_phys" };

// Download a split via the HF datasets-server rows API (no auth, paginated)
// and cache the raw rows on disk; later runs load the cached file.
async function fetchSplit(hfConfig) {
  const file = join(DATASETS_DIR, `${hfConfig}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(HF_DATASET)}&config=${hfConfig}&split=test&offset=${offset}&length=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HF rows fetch failed (${hfConfig} @${offset}): HTTP ${res.status}`);
    const data = await res.json();
    rows.push(...data.rows.map((r) => r.row));
    if (rows.length >= data.num_rows_total) break;
  }
  await mkdir(DATASETS_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(rows, null, 1));
  return rows;
}

// → { name, papers: [{ id, subtasks: [{ question, gold, background }] }] }
// Paper ids are arXiv ids (used as vault scope names and cache keys).
export async function loadArenaSuite(name) {
  const hfConfig = HF_CONFIGS[name];
  if (!hfConfig)
    throw new Error(`unknown suite: ${name} (have: ${Object.keys(HF_CONFIGS).join(", ")}; travel/shopping/search need the MemoryArena env server — not ported yet)`);
  const rows = await fetchSplit(hfConfig);
  const papers = rows.map((r, i) => ({
    id: String(r.paper_name ?? r.id ?? `paper-${i + 1}`).replace(/[^a-zA-Z0-9._-]/g, "_"),
    subtasks: r.questions.map((q, j) => ({
      question: q,
      gold: String(r.answers[j]),
      background: r.backgrounds?.[j] ?? "",
    })),
  }));
  return { name, papers };
}

// ── Prompts (versioned; bump when any template changes) ───────────────────────
//
// The task block mirrors MemoryArena's MathAgent.build_prompt (### BACKGROUND /
// ### PROBLEM, memory context ahead of it); the memory-arm prompts stay thin —
// the ritual under test is the vault server's own MCP instructions.

export const ARENA_PROMPTS_VERSION = 1;

const taskBlock = (sub) => `### BACKGROUND:
${sub.background?.trim() ? sub.background : "No information provided."}

### PROBLEM:
${sub.question}`;

const SOLVE_RULES = `Solve the problem below. Provide concise reasoning, check your work, and state the final answer clearly.`;

export const qaVaultArenaPrompt = (sub) =>
  `You are resuming a long-running mathematical research project. Your earlier working sessions on this project are recorded in your memory directory — consult it first: definitions, notation, and results established in earlier sessions may be needed here.

${SOLVE_RULES}

${taskBlock(sub)}`;

export const qaClosedBookArenaPrompt = (sub) =>
  `${SOLVE_RULES}

${taskBlock(sub)}`;

// entries = memoryEntry() strings from THIS arm's earlier subtasks (the agent's
// own prior answers, like their long_context memory system accumulates).
export const qaFullContextArenaPrompt = (sub, entries) =>
  `${entries.length ? `<memory_context>
${entries.join("\n")}
</memory_context>

` : ""}${SOLVE_RULES}

${taskBlock(sub)}`;

// Their MathAgent.build_memory_entry shape (judge feedback excluded — their
// default judge_result_in_memory=false; the reward signal must not leak).
export const memoryEntry = (sub, answer) =>
  `## Task: ${sub.question}\n## Solution: ${answer}\n`;

// Distill session — the vault arm's counterpart of memory_client.add():
// a separate agent session with write access persists the experience.
export const distillArenaPrompt = (sub, answer) =>
  `A working session on a long-running mathematical research project is ending. In it, you solved the subtask below. The project continues in later sessions with further subtasks that may build on this work — your memory directory is the only thing those sessions will see.

Persist to your memory directory whatever your memory instructions say is worth persisting from this session. Do not re-solve the task; just do the memory work, then reply "done".

--- SUBTASK ---
${sub.question}
--- YOUR SOLUTION ---
${answer}
--- END ---`;

// Ported from MathEnvironment.judge (mathematical-equivalence check), recast
// into the JSON verdict shape our pipeline parses.
export const arenaJudgePrompt = (sub, answer) =>
  `You are a mathematics expert grading a candidate solution against a reference answer.
Determine whether the candidate's final answer is mathematically equivalent to the reference answer for the given problem. Extra reasoning or detail is fine; a missing, contradictory, or mathematically different final answer is not.

Problem: ${sub.question}

Reference answer: ${sub.gold}

Candidate solution: ${answer}

Reply with ONLY this JSON, nothing else: {"verdict":"correct"|"incorrect","reason":"<one sentence>"}`;

// ── Metrics (MemoryArena's eval.py, minus tokenizer deps) ────────────────────
//
// rows: result records with { paper, idx, system, verdict }. Returns per-system:
//   progressScore — mean over papers of (correct subtasks / subtasks)
//   taskSuccess   — fraction of papers whose LAST subtask is correct
//   passrateAtK   — per-position accuracy across papers (k = subtask index)
export function arenaMetrics(rows) {
  const bySystem = {};
  for (const r of rows) (bySystem[r.system] ??= []).push(r);
  const out = {};
  for (const [system, rs] of Object.entries(bySystem)) {
    const byPaper = {};
    for (const r of rs) (byPaper[r.paper] ??= [])[r.idx] = r;
    const papers = Object.values(byPaper);
    const progress = papers.map((subs) => {
      const s = subs.filter(Boolean);
      return s.filter((r) => r.verdict === "correct").length / s.length;
    });
    const success = papers.map((subs) => {
      const s = subs.filter(Boolean);
      return s[s.length - 1]?.verdict === "correct";
    });
    const maxK = Math.max(...papers.map((s) => s.length));
    const passrateAtK = [];
    for (let k = 0; k < maxK; k++) {
      const at = papers.map((s) => s[k]).filter(Boolean);
      if (at.length) passrateAtK.push({ k, n: at.length, rate: at.filter((r) => r.verdict === "correct").length / at.length });
    }
    out[system] = {
      papers: papers.length,
      subtasks: rs.length,
      correct: rs.filter((r) => r.verdict === "correct").length,
      errors: rs.filter((r) => r.verdict === "error" || r.verdict === "unparseable").length,
      progressScore: progress.reduce((a, b) => a + b, 0) / progress.length,
      taskSuccess: success.filter(Boolean).length / success.length,
      passrateAtK,
    };
  }
  return out;
}
