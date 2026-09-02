#!/usr/bin/env node
// Combine locomo results across ALL cells into one cross-cell table:
// per-cell vault accuracy (overall / answerable-only / per-category),
// plus the closed_book / full_context baselines each cell carries.
// Cells live in evals/results/<cell>/ with locomo*.jsonl inside.
// Usage: node evals/combine.mjs [--dir evals/results] [--glob locomo]
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const RESULTS = flag("dir", "evals/results");
const PREFIX = flag("glob", "locomo");

const CATEGORIES = ["multi-hop", "temporal", "open-domain", "single-hop", "adversarial"];
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : "—");
const accStr = (rs) => {
  const ok = rs.filter((r) => r.verdict === "correct").length;
  return `${pct(ok, rs.length)}% (${ok}/${rs.length})`;
};

const cells = [];
for (const e of await readdir(RESULTS, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith(".")) continue;
  const dir = join(RESULTS, e.name);
  const files = (await readdir(dir)).filter((f) => f.startsWith(PREFIX) && f.endsWith(".jsonl")).sort();
  if (!files.length) continue;
  const rows = [];
  const convs = new Set();
  let prov = null;
  for (const f of files) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n").filter(Boolean)) {
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === "result") { rows.push(rec); convs.add(rec.id.replace(/-q\d+$/, "")); }
      else if (rec.type === "provenance") prov = rec;
    }
  }
  cells.push({ name: e.name, rows, convs, prov, files });
}
if (!cells.length) { console.error(`no cells with ${PREFIX}*.jsonl in ${RESULTS}`); process.exit(1); }

const col = (s, w) => String(s).padEnd(w);
const CELL_W = Math.max(...cells.map((c) => c.name.length)) + 2;

console.log("== coverage ==");
for (const c of cells) {
  const bad = c.rows.filter((r) => r.verdict === "error" || r.verdict === "unparseable").length;
  const note = [`${c.convs.size} convs`, `${c.rows.length} rows`, bad ? `⚠ ${bad} error/unparseable` : null]
    .filter(Boolean).join(", ");
  console.log(`${col(c.name, CELL_W)} ${note}`);
}

// Vault vs its baselines. Swap cells (writer2reader-vault-model) carry no
// closed_book/full_context of their own — those depend only on the reader,
// so borrow them from the reader's own cell (reader-vault-model).
console.log("\n== vault vs baselines (closed_book → vault → full_context; recovered = share of closed→full gap) ==");
const byName = Object.fromEntries(cells.map((c) => [c.name, c]));
for (const c of cells) {
  const vault = c.rows.filter((r) => r.system === "vault");
  if (!vault.length) continue;
  const m = c.name.match(/^([a-z]+)2([a-z]+)-(.+)$/);
  const baseName = m ? `${m[2]}-${m[3]}` : c.name;
  const base = byName[baseName];
  const closed = base?.rows.filter((r) => r.system === "closed_book") ?? [];
  const full = base?.rows.filter((r) => r.system === "full_context") ?? [];
  if (!closed.length || !full.length) {
    console.log(`${col(c.name, CELL_W)} no locomo baselines in ${baseName} — skipped`);
    continue;
  }
  const line = (filter) => {
    const [cl, va, fu] = [closed, vault, full].map((rs) => rs.filter(filter));
    const ok = (rs) => rs.filter((r) => r.verdict === "correct").length;
    const rec = pct(ok(va) - ok(cl), ok(fu) - ok(cl));
    return `${pct(ok(cl), cl.length)}% → ${pct(ok(va), va.length)}% → ${pct(ok(fu), fu.length)}%   recovered ${rec}%`;
  };
  const src = m ? `  (baselines: ${baseName})` : "";
  console.log(`${col(c.name, CELL_W)} overall    ${line(() => true)}${src}`);
  console.log(`${col("", CELL_W)} answerable ${line((r) => r.gold !== "NOT_IN_MEMORY")}`);
}

for (const system of ["vault", "full_context", "closed_book"]) {
  const have = cells.filter((c) => c.rows.some((r) => r.system === system));
  if (!have.length) continue;
  console.log(`\n== ${system} ==`);
  for (const c of have) {
    const all = c.rows.filter((r) => r.system === system);
    const answerable = all.filter((r) => r.gold !== "NOT_IN_MEMORY");
    console.log(`${col(c.name, CELL_W)} overall ${col(accStr(all), 18)} answerable-only ${accStr(answerable)}`);
  }
  console.log(`${col("· per category", CELL_W)}`);
  for (const cat of CATEGORIES) {
    const line = have.map((c) => {
      const rs = c.rows.filter((r) => r.system === system && r.category === cat);
      const tag = c.name.replace("-vault-", "/").replace(/qwen[\d.]+-\d+b-[a-z\d]+-/, "qwen-");
      return rs.length ? `${tag}: ${pct(rs.filter((r) => r.verdict === "correct").length, rs.length)}%` : null;
    }).filter(Boolean).join("   ");
    console.log(`  ${col(cat, 12)} ${line}`);
  }
}
