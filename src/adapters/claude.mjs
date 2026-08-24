// Claude Code auto-memory importer — plain-files tier, the easiest case: the
// native format is the vault's own convention. Files from
// ~/.claude/projects/<slug>/memory/ are copied into the matching space's
// candidates/ with source/status stamped. Deterministic code only; judging
// the candidates is the gardener's job.

import { mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { MEMORY_DIR, atomicWrite, exists, stampId } from "../store.mjs";
import { readRegistry } from "../registry.mjs";
import { upsertCandidateFrontmatter } from "./helpers.mjs";

// Claude Code encodes a project root as its path with separators and dots
// replaced by dashes: /Users/aj/Desktop/foo → -Users-aj-Desktop-foo.
const rootToSlug = (root) => root.replace(/[/.]/g, "-");

export default {
  key: "claude",
  title: "Claude Code auto-memory",
  tier: "plain-files",
  kind: "import",
  async run({ dryRun }) {
    const projectsDir = join(homedir(), ".claude", "projects");
    const report = {
      adapter: "claude",
      tier: "plain-files",
      can: "import per-project markdown memories into the matching space's candidates/",
      cannot: "map projects the vault has never seen (unmapped slugs are skipped, never guessed)",
      imported: 0,
      skippedExisting: 0,
      unmapped: [],
      spaces: {},
    };
    if (!(await exists(projectsDir))) return { ...report, notes: ["~/.claude/projects not found — nothing to import"] };

    // Slug → space: exact match via the registry's root→space map, then the
    // "-…-<space>" suffix fallback for spaces created before the registry.
    const registry = await readRegistry();
    const slugToSpace = {};
    for (const [root, space] of Object.entries(registry.spaces ?? {})) slugToSpace[rootToSlug(root)] = space;
    const storeSpaces = (await readdir(MEMORY_DIR, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);

    for (const e of (await readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
      const memDir = join(projectsDir, e.name, "memory");
      if (!(await exists(memDir))) continue;
      const space =
        slugToSpace[e.name] ?? storeSpaces.find((s) => s !== "shared" && e.name.endsWith(`-${s}`));
      if (!space) {
        report.unmapped.push(e.name);
        continue;
      }
      for (const f of (await readdir(memDir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md")) {
        const target = join(MEMORY_DIR, space, "candidates", `claude-${f}`);
        if (await exists(target)) {
          report.skippedExisting++;
          continue;
        }
        const raw = await readFile(join(memDir, f), "utf8");
        const text = stampId(
          upsertCandidateFrontmatter(raw, {
            name: `claude-${basename(f, ".md")}`,
            description: `imported from Claude Code auto-memory (${e.name})`,
            source: "claude-code",
          }),
        );
        if (!dryRun) {
          await mkdir(join(MEMORY_DIR, space, "candidates"), { recursive: true });
          await atomicWrite(target, text);
        }
        report.imported++;
        report.spaces[space] = (report.spaces[space] ?? 0) + 1;
      }
    }
    return report;
  },
};
