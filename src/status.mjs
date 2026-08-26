// status — the three-layer diagnosis: server up? repo wired? and if both,
// the remaining failure mode is session attachment, which only a session
// restart / approval can fix, so say exactly that.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PORT, exists } from "./store.mjs";
import { HARNESSES, dshProfiles } from "./harnesses/index.mjs";
import { readConnections, readRegistry } from "./registry.mjs";

export async function status() {
  const cwd = process.cwd();
  console.log("memroam status\n");

  let banner = null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    banner = (await res.text()).trim().split("\n")[0];
  } catch {}
  console.log(
    banner !== null
      ? `  server   up on port ${PORT} — ${banner}`
      : `  server   down (port ${PORT}) — start it: npx memroam install (or serve)`,
  );

  console.log(`\n  this repo (${cwd}):`);
  for (const h of HARNESSES) {
    const raw = await readFile(join(cwd, h.where), "utf8").catch(() => null);
    const state = raw === null ? "not present" : /vault/i.test(raw) ? "wired" : "present, no vault entry";
    console.log(`  ${(h.key + " ").padEnd(9)}${h.where} ${state}`);
  }
  const agents = await readFile(join(cwd, "AGENTS.md"), "utf8").catch(() => null);
  console.log(
    `  rules    AGENTS.md ${agents === null ? "not present" : /vault/i.test(agents) ? "has the memory section" : "no memory section"}`,
  );

  const registry = await readRegistry();
  const home = homedir();
  console.log("\n  global (install --global):");
  const mcpWired = async (path) => {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw === null) return "not present";
    try {
      return JSON.parse(raw).mcpServers?.vault ? "wired" : "present, no vault entry";
    } catch {
      return raw.trim() === "" ? "present, no vault entry" : "not valid JSON";
    }
  };
  const rulesWired = async (path) => {
    const raw = await readFile(path, "utf8").catch(() => null);
    return raw === null ? "not present" : /vault/i.test(raw) ? "has the memory section" : "no memory section";
  };
  console.log(`  claude   ~/.claude.json ${await mcpWired(join(home, ".claude.json"))} · CLAUDE.md ${await rulesWired(join(home, ".claude", "CLAUDE.md"))}`);
  console.log(`  cursor   ~/.cursor/mcp.json ${await mcpWired(join(home, ".cursor", "mcp.json"))}`);
  const codexToml = await readFile(join(home, ".codex", "config.toml"), "utf8").catch(() => null);
  console.log(
    `  codex    ~/.codex/config.toml ${codexToml === null ? "not present" : codexToml.includes("[mcp_servers.vault]") ? "wired" : "present, no vault entry"} · AGENTS.md ${await rulesWired(join(home, ".codex", "AGENTS.md"))}`,
  );
  const profiles = await dshProfiles();
  const dshWired = [];
  for (const p of profiles) {
    const patch = await readFile(join(home, ".dsh", "profiles", p, "cordis.patch.yml"), "utf8").catch(() => null);
    if (patch !== null && patch.includes("id: mcp-vault")) dshWired.push(p);
  }
  console.log(
    `  dsh      profiles wired: ${dshWired.length}/${profiles.length}${profiles.length ? ` (${profiles.map((p) => (dshWired.includes(p) ? p : `${p}✗`)).join(", ")})` : ""} · AGENTS.md ${await rulesWired(join(home, ".dsh", "AGENTS.md"))}`,
  );
  const openConfig = await readFile(join(home, ".config", "opencode", "opencode.json"), "utf8").catch(() => null);
  let openState = "not present";
  if (openConfig !== null) {
    try {
      openState = JSON.parse(openConfig).mcp?.vault ? "wired" : "present, no vault entry";
    } catch {
      openState = "not valid JSON";
    }
  }
  console.log(
    `  opencode ~/.config/opencode/opencode.json ${openState} · AGENTS.md ${await rulesWired(join(home, ".config", "opencode", "AGENTS.md"))}`,
  );
  console.log(
    `  gemini   ~/.gemini/settings.json ${await mcpWired(join(home, ".gemini", "settings.json"))} · GEMINI.md ${await rulesWired(join(home, ".gemini", "GEMINI.md"))}`,
  );
  // Antigravity rule file: new installs write rules/memroam.md; installs from
  // the memory-vault era wrote rules/memory-vault.md — report whichever exists.
  const agRules = join(home, ".gemini", "config", "rules");
  const agNew = await rulesWired(join(agRules, "memroam.md"));
  const agOld = await rulesWired(join(agRules, "memory-vault.md"));
  const agRulesState =
    agNew !== "not present"
      ? `rules/memroam.md ${agNew}`
      : agOld !== "not present"
        ? `rules/memory-vault.md ${agOld} (legacy name)`
        : "rules/memroam.md not present";
  console.log(
    `  antigravity ~/.gemini/config/mcp_config.json ${await mcpWired(join(home, ".gemini", "config", "mcp_config.json"))} · ${agRulesState}`,
  );
  if (registry.store) console.log(`  store    ${registry.store}`);
  const spaces = Object.entries(registry.spaces ?? {});
  if (spaces.length > 0) {
    console.log(`  spaces   (auto-detected by stdio sessions):`);
    for (const [root, space] of spaces) console.log(`    ${root} → ${space}`);
  }

  const connections = await readConnections();
  if (connections.length === 0) {
    console.log("\n  connected repos: none recorded (installs record here from v0.3.1 on)");
  } else {
    console.log(`\n  connected repos (${connections.length}):`);
    for (const c of connections) {
      const there = await exists(c.repo);
      console.log(`    ${c.repo} → ${c.project}${there ? "" : "  (missing — moved or deleted)"}`);
    }
  }

  console.log(
    "\n  If the server is up and the repo is wired but your agent session has no vault\n" +
      "  tools: MCP servers attach at session start — restart the session and approve\n" +
      "  the vault server. Claude Code remembers a declined approval: run /mcp in the\n" +
      "  session, or `claude mcp reset-project-choices` in the repo, then restart.",
  );
}
