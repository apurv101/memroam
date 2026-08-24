import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exists } from "../store.mjs";
import { removeGlobalRules, upsertGlobalRules } from "./helpers.mjs";

// Profile directories under ~/.dsh/profiles that are real profiles (they
// carry a cordis.yml) — node_modules and stray files are skipped.
export async function dshProfiles() {
  const root = join(homedir(), ".dsh", "profiles");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const e of entries) {
    if (e.isDirectory() && (await exists(join(root, e.name, "cordis.yml")))) profiles.push(e.name);
  }
  return profiles.sort();
}

export default {
  key: "dsh",
  title: "DeepSeek Harness",
  where: "dsh-cordis.patch.yml",
  detect: async () => exists(join(homedir(), ".dsh")),
  async install({ cwd, url, project, dryRun }) {
    // Repo-local Cordis patch with the project-scoped URL. dsh has no repo-level
    // auto-loaded config, so the patch is applied per-session via --patch (or
    // copied into a profile to make it permanent — the file header says how).
    const patchPath = join(cwd, "dsh-cordis.patch.yml");
    // New plugins are added via `- insert:`; a bare `- id:` entry only
    // overrides an existing one and is silently skipped otherwise.
    const patchEntry = `- insert:\n    - id: mcp-vault\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: vault\n        transport: streamable-http\n        url: ${url}\n`;
    const patchContent = `# dsh Cordis patch — load the memory-vault MCP server (project "${project}").\n# Per-session:  dsh --patch ./dsh-cordis.patch.yml [--profile <name>] ["your task"]\n# Permanent:    copy the entry below into ~/.dsh/profiles/<name>/cordis.patch.yml\n# The vault server must be running (npx memory-vault install starts it if down).\n${patchEntry}`;
    const patch = await readFile(patchPath, "utf8").catch(() => null);
    if (patch === patchContent || (patch !== null && patch.includes("id: mcp-vault") && patch.includes(`url: ${url}`))) {
      return ["dsh      dsh-cordis.patch.yml unchanged — run: dsh --patch ./dsh-cordis.patch.yml"];
    }
    if (patch !== null && patch.includes("id: mcp-vault")) {
      return [`dsh      dsh-cordis.patch.yml already has a vault entry with a different url — update it by hand to ${url}`];
    }
    if (patch !== null) {
      if (!dryRun) await writeFile(patchPath, `${patch.trimEnd()}\n\n${patchEntry}`);
      return ["dsh      dsh-cordis.patch.yml updated — run: dsh --patch ./dsh-cordis.patch.yml"];
    }
    if (!dryRun) await writeFile(patchPath, patchContent);
    return ["dsh      dsh-cordis.patch.yml created — run: dsh --patch ./dsh-cordis.patch.yml"];
  },
  async uninstall({ cwd, dryRun }) {
    const patchPath = join(cwd, "dsh-cordis.patch.yml");
    const patch = await readFile(patchPath, "utf8").catch(() => null);
    if (patch === null) return ["dsh      dsh-cordis.patch.yml not present"];
    if (!patch.includes("id: mcp-vault")) return ["dsh      dsh-cordis.patch.yml no vault entry"];
    const cleaned = patch
      .replace(/(?:^|\n)- insert:\n(?:[ \t].*(?:\n|$))*/g, (block) => (block.includes("id: mcp-vault") ? "\n" : block))
      .replace(/(?:^|\n)- id: mcp-vault\n(?:[ \t].*(?:\n|$))*/g, "\n");
    const onlyComments = cleaned.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("#"));
    if (onlyComments) {
      if (!dryRun) await rm(patchPath);
      return ["dsh      dsh-cordis.patch.yml deleted"];
    }
    if (!dryRun) await writeFile(patchPath, cleaned.trimEnd() + "\n");
    return ["dsh      dsh-cordis.patch.yml vault entry removed"];
  },
  // Global dsh wiring: the ritual goes in ~/.dsh/AGENTS.md (loaded above
  // profiles, whatever profile boots), and a stdio mount is fanned into
  // every profile's cordis.patch.yml — profiles don't inherit from any
  // shared plugin layer, so each one needs its own entry. cwd is left
  // unset: dsh-mcp-client then spawns the server in the dsh host's cwd,
  // which is the workspace for headless runs (the web UI host may start
  // elsewhere — those sessions land in the space of wherever it started).
  async globalInstall({ store, command, args, dryRun }) {
    if (!(await exists(join(homedir(), ".dsh")))) return ["dsh      ~/.dsh not found — skipped"];
    const lines = [`dsh      ~/.dsh/AGENTS.md ${await upsertGlobalRules(join(homedir(), ".dsh", "AGENTS.md"), dryRun)}`];
    // dsh patch semantics: a bare `- id:` entry OVERRIDES an existing entry
    // (and warns + skips when none exists); NEW plugins must be added via an
    // `- insert:` block.
    const entry =
      `- insert:\n    - id: mcp-vault\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: vault\n        transport: stdio\n` +
      `        command: ${JSON.stringify(command)}\n        args: ${JSON.stringify(args)}\n        env:\n          MEMORY_DIR: ${JSON.stringify(store)}\n`;
    for (const profile of await dshProfiles()) {
      const patchPath = join(homedir(), ".dsh", "profiles", profile, "cordis.patch.yml");
      const patch = await readFile(patchPath, "utf8").catch(() => null);
      if (patch !== null && patch.includes("id: mcp-vault")) {
        lines.push(`dsh      profiles/${profile} already has a vault entry — left as is`);
      } else {
        if (!dryRun) await writeFile(patchPath, `${patch === null ? "" : patch.trimEnd() + "\n\n"}${entry}`);
        lines.push(`dsh      profiles/${profile}/cordis.patch.yml ${patch === null ? "created" : "updated"} (stdio mount)`);
      }
    }
    return lines;
  },
  async globalUninstall({ dryRun }) {
    if (!(await exists(join(homedir(), ".dsh")))) return ["dsh      ~/.dsh not found — skipped"];
    const lines = [`dsh      ~/.dsh/AGENTS.md ${await removeGlobalRules(join(homedir(), ".dsh", "AGENTS.md"), dryRun)}`];
    for (const profile of await dshProfiles()) {
      const patchPath = join(homedir(), ".dsh", "profiles", profile, "cordis.patch.yml");
      const patch = await readFile(patchPath, "utf8").catch(() => null);
      if (patch === null || !patch.includes("id: mcp-vault")) {
        lines.push(`dsh      profiles/${profile} no vault entry`);
        continue;
      }
      // Remove the insert-wrapped shape (ours only ever holds the vault
      // entry) and the legacy bare-id shape from older installs.
      const cleaned = patch
        .replace(/(?:^|\n)- insert:\n(?:[ \t].*(?:\n|$))*/g, (block) => (block.includes("id: mcp-vault") ? "\n" : block))
        .replace(/(?:^|\n)- id: mcp-vault\n(?:[ \t].*(?:\n|$))*/g, "\n");
      if (!dryRun) await writeFile(patchPath, cleaned.trimEnd() + "\n");
      lines.push(`dsh      profiles/${profile} vault entry removed`);
    }
    return lines;
  },
};
