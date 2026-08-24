// Codex sqlite importer — structured-local-derived tier: locally generated
// derived state over transcript rollouts, authority unverified (design
// contract item 9). Strictly read-only, version-gated: unknown migrations
// mean unknown schema, so the adapter refuses rather than guesses. Rows from
// stage1_outputs become candidates carrying the rollout as their locator.
// The rollout→project mapping is not recoverable from this table, so
// candidates land in the default space.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEMORY_DIR, atomicWrite, exists, stampId } from "../store.mjs";

const DB_PATH = join(homedir(), ".codex", "memories_1.sqlite");
// Verified on this machine 2026-08-23: version 1 = "memories" (tables
// _sqlx_migrations, stage1_outputs, jobs). Any version beyond this set means
// a schema this adapter has never seen.
const KNOWN_MIGRATIONS = new Set([1]);

export default {
  key: "codex",
  title: "Codex transcript-mining sqlite",
  tier: "structured-local-derived",
  kind: "import",
  async run({ dryRun }) {
    const report = {
      adapter: "codex",
      tier: "structured-local-derived",
      can: "read stage1_outputs rows (read-only) into default/candidates/ with the rollout as locator",
      cannot: "map rows to project spaces (no cwd in the table); write anything into Codex's database; read schemas from unknown migration versions",
      imported: 0,
      skippedExisting: 0,
    };
    if (!(await exists(DB_PATH))) return { ...report, notes: ["~/.codex/memories_1.sqlite not found — nothing to import"] };

    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return { ...report, notes: ["node:sqlite unavailable (needs Node >= 22.5) — cannot read the database"] };
    }

    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const migrations = db.prepare("SELECT version FROM _sqlx_migrations").all().map((r) => Number(r.version));
      const unknown = migrations.filter((v) => !KNOWN_MIGRATIONS.has(v));
      if (unknown.length > 0) {
        return { ...report, notes: [`unknown migration version(s) ${unknown.join(", ")} — schema unverified, refusing to read`] };
      }
      const rows = db
        .prepare("SELECT thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at FROM stage1_outputs")
        .all();
      for (const row of rows) {
        const slug = String(row.rollout_slug ?? row.thread_id ?? "row").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
        const target = join(MEMORY_DIR, "default", "candidates", `codex-${slug}.md`);
        if (await exists(target)) {
          report.skippedExisting++;
          continue;
        }
        const firstLine = String(row.raw_memory ?? row.rollout_summary ?? "").split("\n")[0].slice(0, 160);
        const text = stampId(
          `---\nname: codex-${slug}\ndescription: ${firstLine || "imported Codex stage1 observation"}\nsource: codex\nstatus: pending\nlocator: codex rollout ${row.rollout_slug ?? "?"} (thread ${row.thread_id ?? "?"}, source_updated_at ${row.source_updated_at ?? "?"})\n---\n\n${row.raw_memory ?? ""}\n\n${row.rollout_summary ?? ""}\n`,
        );
        if (!dryRun) {
          await mkdir(join(MEMORY_DIR, "default", "candidates"), { recursive: true });
          await atomicWrite(target, text);
        }
        report.imported++;
      }
      return report;
    } finally {
      db.close();
    }
  },
};
