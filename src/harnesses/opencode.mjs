import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exists } from "../store.mjs";
import { mergeOpencodeMcp, removeGlobalRules, removeOpencodeMcp, upsertGlobalRules } from "./helpers.mjs";

export default {
  key: "opencode",
  title: "opencode",
  where: "opencode.json",
  detect: async (cwd) =>
    (await exists(join(homedir(), ".opencode"))) ||
    (await exists(join(homedir(), ".config", "opencode"))) ||
    exists(join(cwd, "opencode.json")),
  // Repo level: opencode reads a project opencode.json; the HTTP server is
  // addressed as a "remote" MCP entry.
  async install({ cwd, url, dryRun }) {
    const status = await mergeOpencodeMcp(join(cwd, "opencode.json"), { type: "remote", url, enabled: true }, dryRun);
    return [`opencode opencode.json ${status} (memroam → ${url})`];
  },
  async uninstall({ cwd, dryRun }) {
    return [`opencode opencode.json ${await removeOpencodeMcp(join(cwd, "opencode.json"), dryRun)}`];
  },
  // Global: ~/.config/opencode/opencode.json ("local" = stdio, command is a
  // single array) + the global rules file ~/.config/opencode/AGENTS.md.
  // opencode also falls back to ~/.claude/CLAUDE.md when its own global
  // rules file is absent, so writing ours must carry the full ritual.
  async globalInstall({ store, command, args, dryRun }) {
    if (!(await exists(join(homedir(), ".opencode"))) && !(await exists(join(homedir(), ".config", "opencode")))) {
      return ["opencode ~/.opencode not found — skipped"];
    }
    const configDir = join(homedir(), ".config", "opencode");
    const entry = { type: "local", command: [command, ...args], enabled: true, environment: { MEMORY_DIR: store } };
    const status = await mergeOpencodeMcp(join(configDir, "opencode.json"), entry, dryRun);
    if (!dryRun) await mkdir(configDir, { recursive: true });
    const rules = dryRun && !(await exists(configDir)) ? "would create with the memory section" : await upsertGlobalRules(join(configDir, "AGENTS.md"), dryRun);
    return [`opencode ~/.config/opencode/opencode.json ${status} (global, stdio)`, `opencode ~/.config/opencode/AGENTS.md ${rules}`];
  },
  async globalUninstall({ dryRun }) {
    const configDir = join(homedir(), ".config", "opencode");
    if (!(await exists(configDir))) return ["opencode ~/.config/opencode not found — skipped"];
    return [
      `opencode ~/.config/opencode/opencode.json ${await removeOpencodeMcp(join(configDir, "opencode.json"), dryRun)}`,
      `opencode ~/.config/opencode/AGENTS.md ${await removeGlobalRules(join(configDir, "AGENTS.md"), dryRun)}`,
    ];
  },
};
