import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exists } from "../store.mjs";
import { CURSOR_RITUAL_SKILL } from "../instructions.mjs";
import { mergeMcpJson, removeMcpJson } from "./helpers.mjs";

export default {
  key: "cursor",
  title: "Cursor",
  where: ".cursor/mcp.json",
  detect: async (cwd) => (await exists(join(homedir(), ".cursor"))) || (await exists(join(cwd, ".cursor"))),
  async install({ cwd, url, dryRun }) {
    const status = await mergeMcpJson(join(cwd, ".cursor", "mcp.json"), { url }, dryRun);
    return [`cursor   .cursor/mcp.json ${status}`];
  },
  async uninstall({ cwd, dryRun }) {
    const status = await removeMcpJson(join(cwd, ".cursor", "mcp.json"), dryRun);
    if (!dryRun && status.startsWith("deleted")) await rmdir(join(cwd, ".cursor")).catch(() => {});
    return [`cursor   .cursor/mcp.json ${status}`];
  },
  // ~/.cursor/mcp.json is Cursor's global MCP config. User-level rules live
  // in app settings (no file), so the always-on ritual is a manual paste —
  // but Cursor loads personal skills from ~/.cursor/skills/, so the ritual
  // also ships as a skill there: on-demand rather than guaranteed-injected,
  // and fully installable/removable by us.
  async globalInstall({ store, command, args, dryRun }) {
    if (!(await exists(join(homedir(), ".cursor")))) return ["cursor   ~/.cursor not found — skipped"];
    const entry = { command, args, env: { MEMORY_DIR: store } };
    const status = await mergeMcpJson(join(homedir(), ".cursor", "mcp.json"), entry, dryRun);
    const skillPath = join(homedir(), ".cursor", "skills", "memory-vault", "SKILL.md");
    const skillExists = await exists(skillPath);
    if (!dryRun && !skillExists) {
      await mkdir(dirname(skillPath), { recursive: true });
      await writeFile(skillPath, CURSOR_RITUAL_SKILL);
    }
    return [
      `cursor   ~/.cursor/mcp.json ${status} (global, stdio)`,
      `cursor   ~/.cursor/skills/memory-vault ${skillExists ? "unchanged" : "created"} (ritual as a personal skill)`,
      "cursor   for always-on recall, also paste the ritual under Settings → Rules (app-managed, not writable)",
    ];
  },
  async globalUninstall({ dryRun }) {
    if (!(await exists(join(homedir(), ".cursor")))) return ["cursor   ~/.cursor not found — skipped"];
    const lines = [`cursor   ~/.cursor/mcp.json ${await removeMcpJson(join(homedir(), ".cursor", "mcp.json"), dryRun)}`];
    const skillDir = join(homedir(), ".cursor", "skills", "memory-vault");
    if (await exists(skillDir)) {
      if (!dryRun) await rm(skillDir, { recursive: true });
      lines.push("cursor   ~/.cursor/skills/memory-vault removed");
    } else {
      lines.push("cursor   ~/.cursor/skills/memory-vault not present");
    }
    return lines;
  },
};
