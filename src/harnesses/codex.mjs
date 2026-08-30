import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exists } from "../store.mjs";
import { removeGlobalRules, upsertGlobalRules } from "./helpers.mjs";

// Strip our [mcp_servers.vault] block — plus its .* sub-tables (per-tool
// approval modes) and the legacy [mcp_servers.memroam] blocks from the
// memroam era. Multiline ^ so consecutive blocks match — a match consumes
// the newline the next block would otherwise need as its (?:^|\n) anchor.
const stripBlocks = (toml) =>
  toml.replace(/^\[mcp_servers\.(?:vault|memroam)(?:\.[^\]]+)?\]\n(?:(?!\[).*(?:\n|$))*/gm, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");

export default {
  key: "codex",
  title: "Codex CLI",
  where: ".codex/config.toml",
  detect: async (cwd) => (await exists(join(homedir(), ".codex"))) || (await exists(join(cwd, ".codex"))),
  async install({ cwd, url, dryRun }) {
    // Project-scoped Codex config (trusted projects). TOML is appended, not
    // parsed — if a vault block already exists we only verify the URL; a
    // legacy memroam block is replaced.
    const tomlPath = join(cwd, ".codex", "config.toml");
    const toml = await readFile(tomlPath, "utf8").catch(() => null);
    if (toml !== null && toml.includes("[mcp_servers.vault]")) {
      return [
        toml.includes(`url = "${url}"`)
          ? "codex    .codex/config.toml unchanged"
          : `codex    .codex/config.toml already has a vault entry with a different url — update it by hand to ${url}`,
      ];
    }
    const legacy = toml !== null && toml.includes("[mcp_servers.memroam]");
    const base = legacy ? stripBlocks(toml).trimEnd() : (toml?.trimEnd() ?? "");
    if (!dryRun) {
      await mkdir(dirname(tomlPath), { recursive: true });
      await writeFile(tomlPath, `${base ? base + "\n\n" : ""}[mcp_servers.vault]\nurl = "${url}"\n`);
    }
    return [
      `codex    .codex/config.toml ${toml === null ? "created" : legacy ? "updated (renamed memroam → vault)" : "updated"} (trusted projects only)`,
    ];
  },
  async uninstall({ cwd, dryRun }) {
    const tomlPath = join(cwd, ".codex", "config.toml");
    const toml = await readFile(tomlPath, "utf8").catch(() => null);
    if (toml === null) return ["codex    .codex/config.toml not present"];
    if (!toml.includes("[mcp_servers.vault]") && !toml.includes("[mcp_servers.memroam]"))
      return ["codex    .codex/config.toml no vault entry"];
    const cleaned = stripBlocks(toml);
    if (cleaned.trim() === "") {
      if (!dryRun) {
        await rm(tomlPath);
        await rmdir(join(cwd, ".codex")).catch(() => {});
      }
      return ["codex    .codex/config.toml deleted (only held the vault entry)"];
    }
    if (!dryRun) await writeFile(tomlPath, cleaned.trimEnd() + "\n");
    return ["codex    .codex/config.toml vault entry removed"];
  },
  // ~/.codex/config.toml is Codex's global config; ~/.codex/AGENTS.md its
  // global instructions file. TOML is appended, not parsed (same policy as
  // the repo-level entry).
  async globalInstall({ store, command, args, dryRun }) {
    if (!(await exists(join(homedir(), ".codex")))) return ["codex    ~/.codex not found — skipped"];
    const lines = [];
    const tomlPath = join(homedir(), ".codex", "config.toml");
    const toml = await readFile(tomlPath, "utf8").catch(() => null);
    if (toml === null || !toml.includes("[mcp_servers.vault]")) {
      const legacy = toml !== null && toml.includes("[mcp_servers.memroam]");
      const base = legacy ? stripBlocks(toml).trimEnd() : (toml?.trimEnd() ?? "");
      const block = `[mcp_servers.vault]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenv = { MEMORY_DIR = ${JSON.stringify(store)} }\n`;
      if (!dryRun) await writeFile(tomlPath, `${base ? base + "\n\n" : ""}${block}`);
      lines.push(
        `codex    ~/.codex/config.toml ${toml === null ? "created" : legacy ? "updated (renamed memroam → vault)" : "updated"} (global, stdio)`,
      );
    } else {
      lines.push("codex    ~/.codex/config.toml already has a vault entry — left as is");
    }
    lines.push(`codex    ~/.codex/AGENTS.md ${await upsertGlobalRules(join(homedir(), ".codex", "AGENTS.md"), dryRun)}`);
    return lines;
  },
  async globalUninstall({ dryRun }) {
    if (!(await exists(join(homedir(), ".codex")))) return ["codex    ~/.codex not found — skipped"];
    const lines = [];
    const tomlPath = join(homedir(), ".codex", "config.toml");
    const toml = await readFile(tomlPath, "utf8").catch(() => null);
    if (toml === null) lines.push("codex    ~/.codex/config.toml not present");
    else if (!toml.includes("[mcp_servers.vault") && !toml.includes("[mcp_servers.memroam"))
      lines.push("codex    ~/.codex/config.toml no vault entry");
    else {
      const cleaned = stripBlocks(toml);
      if (!dryRun) await writeFile(tomlPath, cleaned.trimEnd() + "\n");
      lines.push("codex    ~/.codex/config.toml vault entry removed");
    }
    lines.push(`codex    ~/.codex/AGENTS.md ${await removeGlobalRules(join(homedir(), ".codex", "AGENTS.md"), dryRun)}`);
    return lines;
  },
};
