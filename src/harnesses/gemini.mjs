import { rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exists } from "../store.mjs";
import { mergeMcpJson, removeGlobalRules, removeMcpJson, upsertGlobalRules } from "./helpers.mjs";

export default {
  key: "gemini",
  title: "Gemini CLI",
  where: ".gemini/settings.json",
  detect: async (cwd) => (await exists(join(homedir(), ".gemini"))) || exists(join(cwd, ".gemini")),
  // Same "mcpServers" key as Claude's configs, so mergeMcpJson applies;
  // repo level addresses the HTTP server via Gemini's httpUrl field.
  async install({ cwd, url, dryRun }) {
    const status = await mergeMcpJson(join(cwd, ".gemini", "settings.json"), { httpUrl: url }, dryRun);
    return [`gemini   .gemini/settings.json ${status} (memroam → ${url})`];
  },
  async uninstall({ cwd, dryRun }) {
    const status = await removeMcpJson(join(cwd, ".gemini", "settings.json"), dryRun);
    if (!dryRun && status.startsWith("deleted")) await rmdir(join(cwd, ".gemini")).catch(() => {});
    return [`gemini   .gemini/settings.json ${status}`];
  },
  // Global: ~/.gemini/settings.json (stdio: command/args/env) + the global
  // context file ~/.gemini/GEMINI.md.
  async globalInstall({ store, command, args, dryRun }) {
    if (!(await exists(join(homedir(), ".gemini")))) return ["gemini   ~/.gemini not found — skipped"];
    const entry = { command, args, env: { MEMORY_DIR: store } };
    const status = await mergeMcpJson(join(homedir(), ".gemini", "settings.json"), entry, dryRun);
    const rules = await upsertGlobalRules(join(homedir(), ".gemini", "GEMINI.md"), dryRun);
    return [`gemini   ~/.gemini/settings.json ${status} (global, stdio)`, `gemini   ~/.gemini/GEMINI.md ${rules}`];
  },
  async globalUninstall({ dryRun }) {
    if (!(await exists(join(homedir(), ".gemini")))) return ["gemini   ~/.gemini not found — skipped"];
    return [
      `gemini   ~/.gemini/settings.json ${await removeMcpJson(join(homedir(), ".gemini", "settings.json"), dryRun)}`,
      `gemini   ~/.gemini/GEMINI.md ${await removeGlobalRules(join(homedir(), ".gemini", "GEMINI.md"), dryRun)}`,
    ];
  },
};
