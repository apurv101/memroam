// dsh projection — no native memory tier, so this adapter is export-side
// only: a read-only managed block in ~/.dsh/AGENTS.md mirroring the shared/
// index, regenerated from canonical on every run. dsh's instruction
// reconciler keeps the chain live; the block tells sessions to use the vault
// tools for bodies and writes.

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEMORY_DIR, exists } from "../store.mjs";

const MARK_BEGIN = "<!-- memory-vault:projection:begin -->";
const MARK_END = "<!-- memory-vault:projection:end -->";

export default {
  key: "dsh",
  title: "dsh AGENTS.md projection",
  tier: "no-native-memory",
  kind: "project",
  async run({ dryRun }) {
    const report = {
      adapter: "dsh",
      tier: "no-native-memory",
      can: "project the shared/ index as a read-only managed block in ~/.dsh/AGENTS.md",
      cannot: "project per-project spaces (dsh has no per-repo config chain) or inline memory bodies",
    };
    const agentsPath = join(homedir(), ".dsh", "AGENTS.md");
    if (!(await exists(join(homedir(), ".dsh")))) return { ...report, notes: ["~/.dsh not found — skipped"] };

    const index = await readFile(join(MEMORY_DIR, "shared", "MEMORY.md"), "utf8").catch(() => null);
    if (index === null) return { ...report, notes: ["shared/MEMORY.md not found — nothing to project"] };
    const lines = index.split("\n").filter((l) => l.startsWith("- "));
    const block =
      `${MARK_BEGIN}\n## Shared vault memories (read-only projection)\n\n` +
      `Generated from the vault's shared/ space — do not edit here; read or change these through the vault MCP tools.\n\n` +
      `${lines.join("\n")}\n${MARK_END}\n`;

    const raw = await readFile(agentsPath, "utf8").catch(() => null);
    const marked = new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`);
    let next;
    if (raw === null) next = block;
    else if (marked.test(raw)) next = raw.replace(marked, block);
    else next = `${raw.trimEnd()}\n\n${block}`;
    if (next === raw) return { ...report, projected: lines.length, notes: ["unchanged"] };
    if (!dryRun) await writeFile(agentsPath, next);
    return { ...report, projected: lines.length };
  },
};
