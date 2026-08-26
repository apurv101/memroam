import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exists } from "../store.mjs";
import { GLOBAL_MARKED_SECTION } from "../instructions.mjs";
import { mergeMcpJson, removeMcpJson } from "./helpers.mjs";

const stateDir = () => join(homedir(), ".gemini", "antigravity");
const configDir = () => join(homedir(), ".gemini", "config");
const mcpPath = () => join(configDir(), "mcp_config.json");
const rulesPath = () => join(configDir(), "rules", "memroam.md");
// Installs from the memory-vault era wrote this filename; uninstall and
// install-idempotence must keep recognizing it.
const legacyRulesPath = () => join(configDir(), "rules", "memory-vault.md");

// The rule file is wholly ours — frontmatter plus the standard marked section,
// created and deleted as a unit. trigger: always_on keeps it unconditionally
// loaded (Antigravity's other rule modes are progressive-disclosure).
const RULES_FILE = `---
trigger: always_on
description: Persistent cross-session memory via the vault MCP server
---

${GLOBAL_MARKED_SECTION}`;

export default {
  key: "antigravity",
  title: "Antigravity",
  where: "AGENTS.md",
  // ~/.gemini alone is Gemini CLI; the app's own state dir marks Antigravity.
  detect: async () => exists(stateDir()),
  // No repo-level MCP surface: workspace MCP only ships inside plugins, and
  // Antigravity's remote transport is SSE, which the vault's POST-only
  // Streamable HTTP endpoint doesn't speak. But it discovers the repo-root
  // AGENTS.md natively, so the ritual written by installRules covers the repo
  // level; the tools come from the global stdio registration.
  async install() {
    const raw = await readFile(mcpPath(), "utf8").catch(() => null);
    let wired = false;
    try {
      wired = Boolean(JSON.parse(raw).mcpServers?.vault);
    } catch {}
    return [
      `antigravity reads the repo AGENTS.md natively — MCP is global-only, ${
        wired ? "already wired in ~/.gemini/config/mcp_config.json" : "run: npx -y memroam install --global"
      }`,
    ];
  },
  async uninstall() {
    return ["antigravity no repo-level config (AGENTS.md handled below; MCP is global)"];
  },
  // Global: ~/.gemini/config/mcp_config.json (same "mcpServers" stdio shape as
  // Claude's configs — Antigravity seeds the file empty, which mergeMcpJson
  // tolerates) + an always-on rule file under ~/.gemini/config/rules/.
  async globalInstall({ store, command, args, dryRun }) {
    if (!(await exists(stateDir()))) return ["antigravity ~/.gemini/antigravity not found — skipped"];
    const entry = { command, args, env: { MEMORY_DIR: store } };
    const status = await mergeMcpJson(mcpPath(), entry, dryRun);
    // Either filename counts as installed — don't write a second rule file
    // next to a memory-vault-era one.
    const rulesThere = (await exists(rulesPath())) || (await exists(legacyRulesPath()));
    if (!dryRun && !rulesThere) {
      await mkdir(join(configDir(), "rules"), { recursive: true });
      await writeFile(rulesPath(), RULES_FILE);
    }
    return [
      `antigravity ~/.gemini/config/mcp_config.json ${status} (global, stdio)`,
      `antigravity ~/.gemini/config/rules/memroam.md ${rulesThere ? "unchanged" : "created"} (always-on rule)`,
    ];
  },
  async globalUninstall({ dryRun }) {
    if (!(await exists(stateDir()))) return ["antigravity ~/.gemini/antigravity not found — skipped"];
    const lines = [`antigravity ~/.gemini/config/mcp_config.json ${await removeMcpJson(mcpPath(), dryRun)}`];
    let removed = false;
    for (const path of [rulesPath(), legacyRulesPath()]) {
      if (!(await exists(path))) continue;
      if (!dryRun) {
        await rm(path);
        await rmdir(join(configDir(), "rules")).catch(() => {});
      }
      lines.push(`antigravity ~/.gemini/config/rules/${path.endsWith("memroam.md") ? "memroam.md" : "memory-vault.md"} removed`);
      removed = true;
    }
    if (!removed) lines.push("antigravity ~/.gemini/config/rules/memroam.md not present");
    return lines;
  },
};
