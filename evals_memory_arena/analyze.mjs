#!/usr/bin/env node
// Merge MemoryArena result JSONLs into the headline table — per-system
// progress score, task success rate, pass-rate@k (per subtask position),
// per-paper breakdown, and cost. Metrics follow the benchmark's eval.py
// (progress_score, is_paper_correct, passrate_at_k).
//
// Usage: node evals_memory_arena/analyze.mjs [--cell claude-vault-sonnet]
//        [--glob math] (with one cell folder matching, --cell may be omitted)

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ARENA_DIR, arenaMetrics } from "./lib.mjs";

const args = process.argv.slice(2);
const flagv = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const RESULTS = flagv("dir", join(ARENA_DIR, "results"));
const PREFIX = flagv("glob", "");
const CELL = flagv("cell", null);

const jsonls = async (d) =>
  existsSync(d) ? (await readdir(d)).filter((f) => f.startsWith(PREFIX) && f.endsWith(".jsonl")).sort() : [];

let DIR, files;
if (CELL) {
  DIR = join(RESULTS, CELL);
  files = await jsonls(DIR);
} else {
  const cells = [];
  if (existsSync(RESULTS))
    for (const e of await readdir(RESULTS, { withFileTypes: true }))
      if (e.isDirectory() && (await jsonls(join(RESULTS, e.name))).length) cells.push(e.name);
  if (cells.length === 1) { DIR = join(RESULTS, cells[0]); files = await jsonls(DIR); console.log(`cell: ${cells[0]}`); }
  else if (cells.length > 1) {
    console.error(`multiple cells have ${PREFIX}*.jsonl — pick one with --cell:\n  ${cells.join("\n  ")}`);
    process.exit(1);
  } else { DIR = RESULTS; files = await jsonls(DIR); }
}
if (!files.length) { console.error(`no ${PREFIX}*.jsonl in ${DIR}`); process.exit(1); }

const rows = [];
let distillCost = 0, paperErrors = [];
for (const f of files) {
  for (const line of (await readFile(join(DIR, f), "utf8")).split("\n").filter(Boolean)) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "result") rows.push(rec);
    else if (rec.type === "distill" && rec.costUsd) distillCost += rec.costUsd;
    else if (rec.type === "paper_error") paperErrors.push(rec);
  }
}

console.log(`files: ${files.join(", ")}\n`);
if (paperErrors.length) {
  console.log(`⚠ ${paperErrors.length} aborted paper(s) — their remaining subtasks are absent:`);
  for (const p of paperErrors) console.log(`  ${p.paper}: ${p.reason}`);
  console.log();
}
const bad = rows.filter((r) => r.verdict === "error" || r.verdict === "unparseable");
if (bad.length) console.log(`⚠ ${bad.length} error/unparseable rows remain — numbers below exclude nothing\n`);

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const metrics = arenaMetrics(rows);
const systems = Object.keys(metrics).sort();

console.log("== overall (MemoryArena metrics) ==");
for (const sys of systems) {
  const m = metrics[sys];
  console.log(`${sys.padEnd(13)} progress-score ${pct(m.progressScore).padEnd(7)} task-success ${pct(m.taskSuccess).padEnd(7)} subtasks ${m.correct}/${m.subtasks} over ${m.papers} papers${m.errors ? `  (${m.errors} errors)` : ""}`);
}

console.log("\n== pass-rate@k (accuracy at each subtask position) ==");
for (const sys of systems) {
  const line = metrics[sys].passrateAtK.map(({ k, rate }) => `q${k + 1} ${pct(rate)}`).join("  ");
  console.log(`${sys.padEnd(13)} ${line}`);
}

console.log("\n== per paper (correct/total per system) ==");
const papers = [...new Set(rows.map((r) => r.paper))].sort();
for (const paper of papers) {
  const line = systems.map((sys) => {
    const rs = rows.filter((r) => r.paper === paper && r.system === sys).sort((a, b) => a.idx - b.idx);
    if (!rs.length) return `${sys}: —`;
    const marks = rs.map((r) => (r.verdict === "correct" ? "✓" : r.verdict === "incorrect" ? "✗" : "!")).join("");
    return `${sys}: ${marks}`;
  }).join("   ");
  console.log(`${paper.padEnd(14)} ${line}`);
}

console.log("\n== cost ==");
for (const sys of systems) {
  const all = rows.filter((r) => r.system === sys);
  const qa = all.reduce((s, r) => s + (r.qaCostUsd ?? 0), 0);
  const judge = all.reduce((s, r) => s + (r.judgeCostUsd ?? 0), 0);
  console.log(`${sys.padEnd(13)} qa $${qa.toFixed(2)} (${(qa / (all.length || 1)).toFixed(3)}/q)   judge $${judge.toFixed(2)}`);
}
console.log(`distill       $${distillCost.toFixed(2)}`);
