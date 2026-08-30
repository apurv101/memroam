import { homedir } from "node:os";
import { join } from "node:path";
import { exists } from "../store.mjs";
import { mergeMcpJson, removeGlobalRules, removeMcpJson, upsertGlobalRules } from "./helpers.mjs";

export default {
  key: "claude",
  title: "Claude Code",
  where: ".mcp.json",
  // .mcp.json is the repo-level MCP convention, useful beyond Claude Code —
  // always on.
  detect: async () => true,
  async install({ cwd, url, dryRun }) {
    const status = await mergeMcpJson(join(cwd, ".mcp.json"), { type: "http", url }, dryRun);
    return [`claude   .mcp.json ${status} (vault → ${url})`];
  },
  async uninstall({ cwd, dryRun }) {
    return [`claude   .mcp.json ${await removeMcpJson(join(cwd, ".mcp.json"), dryRun)}`];
  },
  // User scope: ~/.claude.json holds user-level MCP servers (what
  // `claude mcp add --scope user` writes); the ritual goes in the global
  // ~/.claude/CLAUDE.md, the one file injected into every session.
  async globalInstall({ store, command, args, dryRun }) {
    if (!(await exists(join(homedir(), ".claude")))) return ["claude   ~/.claude not found — skipped"];
    const entry = { type: "stdio", command, args, env: { MEMORY_DIR: store } };
    const status = await mergeMcpJson(join(homedir(), ".claude.json"), entry, dryRun);
    const rules = await upsertGlobalRules(join(homedir(), ".claude", "CLAUDE.md"), dryRun);
    return [`claude   ~/.claude.json ${status} (user scope, stdio)`, `claude   ~/.claude/CLAUDE.md ${rules}`];
  },
  async globalUninstall({ dryRun }) {
    if (!(await exists(join(homedir(), ".claude")))) return ["claude   ~/.claude not found — skipped"];
    return [
      `claude   ~/.claude.json ${await removeMcpJson(join(homedir(), ".claude.json"), dryRun)}`,
      `claude   ~/.claude/CLAUDE.md ${await removeGlobalRules(join(homedir(), ".claude", "CLAUDE.md"), dryRun)}`,
    ];
  },
};
