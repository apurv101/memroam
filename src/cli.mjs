// CLI — install/uninstall (per-repo and --global) and the command dispatch
// (status lives in status.mjs). The bin entry (server.mjs) calls runCli with
// its own resolved path, which stays the file the registrations point at and
// the file install respawns for the HTTP server.

import { mkdir } from "node:fs/promises";
import { openSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { MEMORY_DIR, PORT, setMemoryDir } from "./store.mjs";
import { server, stdioServe } from "./transports.mjs";
import { HARNESSES, installRules, uninstallRules } from "./harnesses/index.mjs";
import { runAdapters } from "./adapters/index.mjs";
import { status } from "./status.mjs";
import {
  CONNECTIONS_PATH,
  projectSlug,
  readConnections,
  readRegistry,
  writeConnections,
  writeRegistry,
} from "./registry.mjs";

// The bin entry's path (server.mjs), set by runCli — what registrations run
// and what install respawns for the HTTP server.
let SELF;

async function serverUp() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

// Interactive harness picker — plain readline, no dependencies. Only used
// when stdin/stdout are a terminal and no --harness/--yes flag was given.
async function pickHarnesses(detected) {
  console.log("Harnesses to wire to the vault:\n");
  HARNESSES.forEach((h, i) => {
    const mark = detected.includes(h.key) ? "detected" : "not detected";
    console.log(`  ${i + 1}. ${h.key.padEnd(8)} ${h.title.padEnd(18)} ${h.where.padEnd(24)} ${mark}`);
  });
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question(`\nInstall for [${detected.join(", ")}] — Enter to accept, or list keys/numbers, or "all": `)
  ).trim();
  rl.close();
  if (answer === "") return detected;
  if (answer.toLowerCase() === "all") return HARNESSES.map((h) => h.key);
  const keys = [];
  for (const tok of answer.split(/[,\s]+/).filter(Boolean)) {
    const h = /^\d+$/.test(tok) ? HARNESSES[Number(tok) - 1] : HARNESSES.find((x) => x.key === tok.toLowerCase());
    if (!h) throw new Error(`unknown harness: ${tok} (known: ${HARNESSES.map((x) => x.key).join(", ")})`);
    if (!keys.includes(h.key)) keys.push(h.key);
  }
  return keys;
}

async function install(argv) {
  let project = null;
  let dryRun = false;
  let harnessFlag = null;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") project = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--harness") harnessFlag = argv[++i];
    else if (argv[i] === "--yes" || argv[i] === "-y") yes = true;
    else
      throw new Error(
        `unknown flag: ${argv[i]} (usage: memory-vault install [--project <name>] [--harness <keys>] [--yes] [--dry-run])`,
      );
  }
  const cwd = process.cwd();
  project = projectSlug(project ?? basename(cwd));
  if (!project) throw new Error("could not derive a project name from the directory — pass --project <name>");
  const url = `http://localhost:${PORT}/mcp/${project}`;
  const ctx = { cwd, url, project, dryRun };
  const lines = [];

  // 1. The server. If it's already up it keeps its own MEMORY_DIR; only a
  // fresh start needs a store location.
  if (await serverUp()) {
    lines.push(`server   already running on port ${PORT}`);
  } else if (dryRun) {
    lines.push(`server   down — would start it (store: ${process.env.MEMORY_DIR ?? join(homedir(), ".memory-vault")})`);
  } else {
    const storeDir = resolve(process.env.MEMORY_DIR ?? join(homedir(), ".memory-vault"));
    const log = openSync(join(tmpdir(), "memory-vault.log"), "a");
    spawn(process.execPath, [SELF], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, MEMORY_DIR: storeDir },
    }).unref();
    for (let i = 0; i < 20 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await serverUp())) throw new Error(`started the server but it did not come up — see ${join(tmpdir(), "memory-vault.log")}`);
    lines.push(`server   started on port ${PORT} (store: ${storeDir}, log: ${join(tmpdir(), "memory-vault.log")})`);
  }

  // 2. Pick harnesses: --harness wins; otherwise the detected set, confirmed
  // interactively when there's a terminal to ask.
  const detected = [];
  for (const h of HARNESSES) if (await h.detect(cwd)) detected.push(h.key);
  let selected;
  if (harnessFlag !== null) {
    selected = harnessFlag.split(/[,\s]+/).filter(Boolean);
    for (const key of selected) {
      if (!HARNESSES.some((h) => h.key === key))
        throw new Error(`unknown harness: ${key} (known: ${HARNESSES.map((h) => h.key).join(", ")})`);
    }
  } else if (yes || dryRun || !process.stdin.isTTY || !process.stdout.isTTY) {
    selected = detected;
  } else {
    selected = await pickHarnesses(detected);
  }

  // 3. MCP registration for each selected harness, then the shared ritual.
  for (const h of HARNESSES) {
    if (selected.includes(h.key)) lines.push(...(await h.install(ctx)));
    else lines.push(`${h.key.padEnd(9)}${detected.includes(h.key) ? "skipped" : "not detected — skipped"}`);
  }
  if (selected.length > 0) lines.push(...(await installRules(ctx)));

  // 4. Record the connection so status / a future uninstall --all can find it.
  if (selected.length > 0 && !dryRun) {
    const connections = (await readConnections()).filter((c) => c.repo !== cwd);
    connections.push({ repo: cwd, project, url, harnesses: selected, installedAt: new Date().toISOString() });
    await writeConnections(connections);
    lines.push(`registry ${CONNECTIONS_PATH} recorded`);
  }

  console.log(`memory-vault install — project "${project}"${dryRun ? " (dry run)" : ""}\n`);
  for (const l of lines) console.log(`  ${l}`);
  console.log("\nRestart your session and approve the vault MCP server when prompted.");
}

async function uninstall(argv) {
  let project = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") project = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
    else throw new Error(`unknown flag: ${argv[i]} (usage: memory-vault uninstall [--project <name>] [--dry-run])`);
  }
  const cwd = process.cwd();
  project = projectSlug(project ?? basename(cwd));
  const ctx = { cwd, project, dryRun };
  const lines = [];
  for (const h of HARNESSES) lines.push(...(await h.uninstall(ctx)));
  lines.push(...(await uninstallRules(ctx)));

  const connections = await readConnections();
  if (connections.some((c) => c.repo === cwd)) {
    if (!dryRun) await writeConnections(connections.filter((c) => c.repo !== cwd));
    lines.push("registry connection entry removed");
  } else {
    lines.push("registry no entry for this repo");
  }

  console.log(`memory-vault uninstall — project "${project}"${dryRun ? " (dry run)" : ""}\n`);
  for (const l of lines) console.log(`  ${l}`);
  console.log(
    "\nYour memories are untouched — the store stays in the vault directory (default ~/.memory-vault).\n" +
      "The server keeps running for other projects; restart your agent session to drop the vault tools.",
  );
}

// ── global install — wire every harness on this machine, once ────────────────
//
// One stdio MCP registration per harness at its user-global level, plus the
// memory ritual in its global rules file. No per-repo setup after this: each
// session's stdio instance detects the project space from its own cwd.

// The command the harness registrations should run. A local checkout (or a
// dev clone) is addressed directly so the registration keeps working — and
// keeps testing the working copy; an npx/npm-installed copy lives in a cache
// or global tree that may move, so registrations go through npx instead.
function stdioLaunch() {
  return SELF.includes(`${sep}node_modules${sep}`)
    ? { command: "npx", args: ["-y", "memory-vault", "stdio"] }
    : { command: process.execPath, args: [SELF, "stdio"] };
}

async function installGlobal(argv) {
  let dryRun = false;
  let storeFlag = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--store") storeFlag = argv[++i];
    else throw new Error(`unknown flag: ${argv[i]} (usage: memory-vault install --global [--store <dir>] [--dry-run])`);
  }
  const registry = await readRegistry();
  const store = resolve(storeFlag ?? process.env.MEMORY_DIR ?? registry.store ?? join(homedir(), ".memory-vault"));
  const { command, args } = stdioLaunch();
  const ctx = { store, command, args, dryRun };
  const lines = [`store    ${store}`, `runs     ${command} ${args.join(" ")}`];
  for (const h of HARNESSES) lines.push(...(await h.globalInstall(ctx)));
  if (!dryRun) {
    registry.store = store;
    registry.global = { installedAt: new Date().toISOString(), command, args };
    await writeRegistry(registry);
    lines.push(`registry ${CONNECTIONS_PATH} recorded`);
  }
  console.log(`memory-vault install --global${dryRun ? " (dry run)" : ""}\n`);
  for (const l of lines) console.log(`  ${l}`);
  console.log("\nRestart your sessions; each one gets the vault tools and lands in its own project space automatically.");
}

async function uninstallGlobal(argv) {
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else throw new Error(`unknown flag: ${argv[i]} (usage: memory-vault uninstall --global [--dry-run])`);
  }
  const lines = [];
  for (const h of HARNESSES) lines.push(...(await h.globalUninstall({ dryRun })));
  const registry = await readRegistry();
  if (registry.global) {
    if (!dryRun) {
      delete registry.global;
      await writeRegistry(registry);
    }
    lines.push("registry global entry removed (store path and space map kept for reinstall)");
  }
  console.log(`memory-vault uninstall --global${dryRun ? " (dry run)" : ""}\n`);
  for (const l of lines) console.log(`  ${l}`);
  console.log("\nYour memories are untouched.");
}

// ── adapters — import native memory, project to memoryless harnesses ─────────

async function adapterCommand(kind, argv) {
  let dryRun = false;
  let json = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else throw new Error(`unknown flag: ${a} (usage: memory-vault ${kind === "import" ? "import" : "project"} [--dry-run] [--json])`);
  }
  const registry = await readRegistry();
  setMemoryDir(process.env.MEMORY_DIR ?? registry.store ?? join(homedir(), ".memory-vault"));
  const reports = await runAdapters(kind, { dryRun });
  if (json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  console.log(`memory-vault ${kind}${dryRun ? " (dry run)" : ""} — store: ${MEMORY_DIR}\n`);
  for (const r of reports) {
    console.log(`  ${r.adapter} (${r.tier ?? "?"})`);
    if (r.error) {
      console.log(`    error:  ${r.error}`);
      continue;
    }
    console.log(`    can:    ${r.can}`);
    console.log(`    cannot: ${r.cannot}`);
    if (r.imported !== undefined)
      console.log(`    imported: ${r.imported}${r.skippedExisting ? ` (skipped ${r.skippedExisting} already imported)` : ""}`);
    if (r.spaces && Object.keys(r.spaces).length > 0)
      console.log(`    into: ${Object.entries(r.spaces).map(([s, n]) => `${s}/candidates (${n})`).join(", ")}`);
    if (r.unmapped?.length > 0) console.log(`    unmapped projects skipped: ${r.unmapped.join(", ")}`);
    if (r.projected !== undefined) console.log(`    projected: ${r.projected} shared memories`);
    for (const n of r.notes ?? []) console.log(`    note: ${n}`);
  }
  if (kind === "import") console.log("\nImported observations sit in candidates/ (searchable, labeled) until the gardener promotes them.");
}

// ── CLI dispatch ──────────────────────────────────────────────────────────────

const USAGE = `memory-vault — Claude-style memory over a local folder, via MCP

  memory-vault install --global
                            wire every harness on this machine to the vault,
                            once: a stdio MCP registration per harness plus
                            the memory ritual in its global rules file. Every
                            session then gets the vault with no per-repo
                            setup; the project space is detected from each
                            session's directory automatically.
                            [--store <dir>] [--dry-run]
  memory-vault uninstall --global
                            undo install --global; memories are never touched
                            [--dry-run]
  memory-vault stdio        MCP over stdin/stdout (what the global
                            registrations run)
  memory-vault [serve]      serve the vault over HTTP (MEMORY_DIR, VAULT_PORT)
  memory-vault install      wire only the current repo (team-shared configs,
                            custom space name)          (alias: connect)
                            [--project <name>] [--harness <keys>] [--yes] [--dry-run]
  memory-vault uninstall    undo install for this repo  (alias: disconnect)
                            [--project <name>] [--dry-run]
  memory-vault import       import native harness memory (Claude auto-memory,
                            Codex sqlite) into candidates/ [--dry-run] [--json]
  memory-vault project      regenerate read-only projections for harnesses
                            without native memory (dsh)   [--dry-run] [--json]
  memory-vault status       show server state, this repo's wiring, the global
                            wiring, and every repo recorded by install`;

export async function runCli(argv, self) {
  SELF = self;
  const cmd = argv[0];
  const rest = argv.slice(1);
  const isGlobal = rest.includes("--global");
  const restWithoutGlobal = rest.filter((a) => a !== "--global");
  if (cmd === "install" || cmd === "connect") {
    try {
      if (isGlobal) await installGlobal(restWithoutGlobal);
      else await install(rest);
    } catch (err) {
      console.error(`memory-vault install: ${err.message}`);
      process.exit(1);
    }
  } else if (cmd === "uninstall" || cmd === "disconnect") {
    try {
      if (isGlobal) await uninstallGlobal(restWithoutGlobal);
      else await uninstall(rest);
    } catch (err) {
      console.error(`memory-vault uninstall: ${err.message}`);
      process.exit(1);
    }
  } else if (cmd === "import" || cmd === "project") {
    try {
      await adapterCommand(cmd, rest);
    } catch (err) {
      console.error(`memory-vault ${cmd}: ${err.message}`);
      process.exit(1);
    }
  } else if (cmd === "stdio") {
    await stdioServe();
  } else if (cmd === "status") {
    await status();
  } else if (cmd === undefined || cmd === "serve") {
    await mkdir(MEMORY_DIR, { recursive: true });
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`memory-vault serving ${MEMORY_DIR}`);
      console.log(`MCP endpoints: http://localhost:${PORT}/mcp/<project> (scoped), http://localhost:${PORT}/mcp (whole vault)`);
    });
  } else {
    console.log(USAGE);
    process.exit(cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 1);
  }
}
