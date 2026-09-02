// Shared config-file plumbing for the harness registry: JSON MCP-config
// merge/remove (Claude-style "mcpServers" and opencode's "mcp" shape) and the
// user-global rules-file upsert/remove used by every globalInstall.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GLOBAL_MARKED_SECTION, MARKED_SECTION_RE } from "../instructions.mjs";

// Append the global ritual to one harness's user-global rules file. The file's
// parent directory must already exist (the caller detects the harness first);
// a file that already mentions the vault (or memroam, its old name) is left alone.
export async function upsertGlobalRules(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw !== null && /memroam|vault/i.test(raw)) return "unchanged (already mentions vault)";
  if (!dryRun) await writeFile(path, raw === null ? GLOBAL_MARKED_SECTION : `${raw.trimEnd()}\n\n${GLOBAL_MARKED_SECTION}`);
  return raw === null ? "created with the memory section" : "memory section appended";
}

export async function removeGlobalRules(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return "not present";
  const marked = MARKED_SECTION_RE;
  if (!marked.test(raw)) {
    return /memroam|vault/i.test(raw) ? "mentions vault but not the managed section — edit by hand" : "no memory section";
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
// the memroam era registered the server as "memroam" — that key is dropped
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
      throw new Error(`${path} is not valid JSON — fix it or add the vault entry by hand`);
    }
  }
  config.mcpServers ??= {};
  if (JSON.stringify(config.mcpServers.vault) === JSON.stringify(entry) && !config.mcpServers.memroam) return "unchanged";
  const status = raw === null ? "created" : "updated";
  config.mcpServers.vault = entry;
  delete config.mcpServers.memroam;
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return status;
}

// Reverse of mergeMcpJson: drop the vault entry (and any legacy "memroam"
// one), delete the file if that was all it held. Returns a status string.
export async function removeMcpJson(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return "not present";
  if (raw.trim() === "") return "no vault entry";
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return "not valid JSON — remove the vault entry by hand";
  }
  if (!config.mcpServers?.vault && !config.mcpServers?.memroam) return "no vault entry";
  delete config.mcpServers.vault;
  delete config.mcpServers.memroam;
  const empty = Object.keys(config).length === 1 && Object.keys(config.mcpServers).length === 0;
  if (!dryRun) {
    if (empty) await rm(path);
    else await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return empty ? "deleted (only held the vault entry)" : "vault entry removed";
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
      throw new Error(`${path} is not valid JSON — fix it or add the vault entry by hand`);
    }
  }
  config.mcp ??= {};
  if (JSON.stringify(config.mcp.vault) === JSON.stringify(entry) && !config.mcp.memroam) return "unchanged";
  const status = raw === null ? "created" : "updated";
  config.mcp.vault = entry;
  delete config.mcp.memroam;
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
    return "not valid JSON — remove the vault entry by hand";
  }
  if (!config.mcp?.vault && !config.mcp?.memroam) return "no vault entry";
  delete config.mcp.vault;
  delete config.mcp.memroam;
  const empty = Object.keys(config).every((k) => k === "mcp" || k === "$schema") && Object.keys(config.mcp).length === 0;
  if (!dryRun) {
    if (empty) await rm(path);
    else await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return empty ? "deleted (only held the vault entry)" : "vault entry removed";
}
