// Shared config-file plumbing for the harness registry: JSON MCP-config
// merge/remove (Claude-style "mcpServers" and opencode's "mcp" shape) and the
// user-global rules-file upsert/remove used by every globalInstall.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GLOBAL_MARKED_SECTION } from "../instructions.mjs";

// Append the global ritual to one harness's user-global rules file. The file's
// parent directory must already exist (the caller detects the harness first);
// a file that already mentions memroam (or the vault, its old name) is left alone.
export async function upsertGlobalRules(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw !== null && /vault|memroam/i.test(raw)) return "unchanged (already mentions memroam)";
  if (!dryRun) await writeFile(path, raw === null ? GLOBAL_MARKED_SECTION : `${raw.trimEnd()}\n\n${GLOBAL_MARKED_SECTION}`);
  return raw === null ? "created with the memory section" : "memory section appended";
}

export async function removeGlobalRules(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return "not present";
  const marked = /(?:^|\n)<!-- memory-vault:begin -->\n[\s\S]*?<!-- memory-vault:end -->\n?/;
  if (!marked.test(raw)) {
    return /vault|memroam/i.test(raw) ? "mentions memroam but not the managed section — edit by hand" : "no memory section";
  }
  const cleaned = raw.replace(marked, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned === "") {
    if (!dryRun) await rm(path);
    return "deleted (only held the memory section)";
  }
  if (!dryRun) await writeFile(path, cleaned + "\n");
  return "memory section removed";
}

// Merge one entry into a { mcpServers: { ... } } JSON config, preserving the
// rest of the file. Returns "created" | "updated" | "unchanged". Installs from
// the memory-vault era registered the server as "vault" — that key is dropped
// on merge so an upgrade doesn't leave two registrations.
export async function mergeMcpJson(path, entry, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  let config = {};
  // A whitespace-only file counts as empty, not invalid — Antigravity seeds
  // ~/.gemini/config/mcp_config.json as a 0-byte file.
  if (raw !== null && raw.trim() !== "") {
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error(`${path} is not valid JSON — fix it or add the memroam entry by hand`);
    }
  }
  config.mcpServers ??= {};
  if (JSON.stringify(config.mcpServers.memroam) === JSON.stringify(entry) && !config.mcpServers.vault) return "unchanged";
  const status = raw === null ? "created" : "updated";
  config.mcpServers.memroam = entry;
  delete config.mcpServers.vault;
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return status;
}

// Reverse of mergeMcpJson: drop the memroam entry (and any legacy "vault"
// one), delete the file if that was all it held. Returns a status string.
export async function removeMcpJson(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return "not present";
  if (raw.trim() === "") return "no memroam entry";
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return "not valid JSON — remove the memroam entry by hand";
  }
  if (!config.mcpServers?.memroam && !config.mcpServers?.vault) return "no memroam entry";
  delete config.mcpServers.memroam;
  delete config.mcpServers.vault;
  const empty = Object.keys(config).length === 1 && Object.keys(config.mcpServers).length === 0;
  if (!dryRun) {
    if (empty) await rm(path);
    else await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return empty ? "deleted (only held the memroam entry)" : "memroam entry removed";
}

// opencode's config nests servers under "mcp" (not "mcpServers"), so it gets
// its own merge/remove pair with the same created/updated/unchanged contract.
export async function mergeOpencodeMcp(path, entry, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  let config = {};
  if (raw !== null) {
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error(`${path} is not valid JSON — fix it or add the memroam entry by hand`);
    }
  }
  config.mcp ??= {};
  if (JSON.stringify(config.mcp.memroam) === JSON.stringify(entry) && !config.mcp.vault) return "unchanged";
  const status = raw === null ? "created" : "updated";
  config.mcp.memroam = entry;
  delete config.mcp.vault;
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return status;
}

export async function removeOpencodeMcp(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return "not present";
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return "not valid JSON — remove the memroam entry by hand";
  }
  if (!config.mcp?.memroam && !config.mcp?.vault) return "no memroam entry";
  delete config.mcp.memroam;
  delete config.mcp.vault;
  const empty = Object.keys(config).every((k) => k === "mcp" || k === "$schema") && Object.keys(config.mcp).length === 0;
  if (!dryRun) {
    if (empty) await rm(path);
    else await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return empty ? "deleted (only held the memroam entry)" : "memroam entry removed";
}
