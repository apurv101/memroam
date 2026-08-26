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

// Matches our entry id under either name — memory-vault-era installs wrote
// `id: mcp-vault`.
const OUR_ID = /id: mcp-(?:memroam|vault)\b/;

// Remove our entry from a Cordis patch: the insert-wrapped shape (ours only
// ever holds the memroam entry) and the legacy bare-id shape from older
// installs, under either id.
const stripEntries = (patch) =>
  patch
    .replace(/(?:^|\n)- insert:\n(?:[ \t].*(?:\n|$))*/g, (block) => (OUR_ID.test(block) ? "\n" : block))
    .replace(/(?:^|\n)- id: mcp-(?:memroam|vault)\n(?:[ \t].*(?:\n|$))*/g, "\n");

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
    const patchEntry = `- insert:\n    - id: mcp-memroam\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memroam\n        transport: streamable-http\n        url: ${url}\n`;
    const patchContent = `# dsh Cordis patch — load the Memroam MCP server (project "${project}").\n# Per-session:  dsh --patch ./dsh-cordis.patch.yml [--profile <name>] ["your task"]\n# Permanent:    copy the entry below into ~/.dsh/profiles/<name>/cordis.patch.yml\n# The memroam server must be running (npx memroam install starts it if down).\n${patchEntry}`;
    const patch = await readFile(patchPath, "utf8").catch(() => null);
    if (patch === patchContent || (patch !== null && patch.includes("id: mcp-memroam") && patch.includes(`url: ${url}`))) {
      return ["dsh      dsh-cordis.patch.yml unchanged — run: dsh --patch ./dsh-cordis.patch.yml"];
    }
    if (patch !== null && patch.includes("id: mcp-memroam")) {
      return [`dsh      dsh-cordis.patch.yml already has a memroam entry with a different url — update it by hand to ${url}`];
    }
    if (patch !== null && patch.includes("id: mcp-vault")) {
      // Legacy entry from the memory-vault era — replace it with the renamed one.
      const base = stripEntries(patch).trim();
      const onlyComments = base.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("#"));
      if (!dryRun) await writeFile(patchPath, onlyComments ? patchContent : `${base}\n\n${patchEntry}`);
      return ["dsh      dsh-cordis.patch.yml updated (renamed vault → memroam) — run: dsh --patch ./dsh-cordis.patch.yml"];
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
    if (!OUR_ID.test(patch)) return ["dsh      dsh-cordis.patch.yml no memroam entry"];
    const cleaned = stripEntries(patch);
    const onlyComments = cleaned.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("#"));
    if (onlyComments) {
      if (!dryRun) await rm(patchPath);
      return ["dsh      dsh-cordis.patch.yml deleted"];
    }
    if (!dryRun) await writeFile(patchPath, cleaned.trimEnd() + "\n");
    return ["dsh      dsh-cordis.patch.yml memroam entry removed"];
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
      `- insert:\n    - id: mcp-memroam\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memroam\n        transport: stdio\n` +
      `        command: ${JSON.stringify(command)}\n        args: ${JSON.stringify(args)}\n        env:\n          MEMORY_DIR: ${JSON.stringify(store)}\n`;
    for (const profile of await dshProfiles()) {
      const patchPath = join(homedir(), ".dsh", "profiles", profile, "cordis.patch.yml");
      const patch = await readFile(patchPath, "utf8").catch(() => null);
      if (patch !== null && patch.includes("id: mcp-memroam")) {
        lines.push(`dsh      profiles/${profile} already has a memroam entry — left as is`);
      } else if (patch !== null && patch.includes("id: mcp-vault")) {
        const base = stripEntries(patch).trim();
        if (!dryRun) await writeFile(patchPath, `${base ? base + "\n\n" : ""}${entry}`);
        lines.push(`dsh      profiles/${profile}/cordis.patch.yml updated (renamed vault → memroam, stdio mount)`);
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
      if (patch === null || !OUR_ID.test(patch)) {
        lines.push(`dsh      profiles/${profile} no memroam entry`);
        continue;
      }
      const cleaned = stripEntries(patch);
      if (!dryRun) await writeFile(patchPath, cleaned.trimEnd() + "\n");
      lines.push(`dsh      profiles/${profile} memroam entry removed`);
    }
    return lines;
  },
};
