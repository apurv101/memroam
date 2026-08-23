#!/usr/bin/env node
// Memory Vault — Claude-style memory primitives over a local folder, via MCP.
//
//   npx memory-vault install --global — wire every harness on this machine to
//                                    the vault once, user-globally: a stdio MCP
//                                    registration per harness plus the memory
//                                    ritual in its global rules file. Sessions
//                                    then get vault tools in every repo with no
//                                    per-repo setup; the stdio server derives
//                                    the project space from its working
//                                    directory automatically.
//   npx memory-vault stdio         — MCP over stdin/stdout (what the global
//                                    registrations run; spawned by the harness
//                                    in the session's directory)
//   node server.mjs                (or: npm start) — serve the vault over HTTP
//   npx memory-vault install       — wire the current repo to the vault
//                                    (starts the server if down, lets you pick
//                                    harnesses, writes each one's MCP config +
//                                    the shared rules files; alias: connect)
//   npx memory-vault uninstall     — undo install for the repo (--global: undo
//                                    install --global); memories are never
//                                    touched (alias: disconnect)
//
// The store is a plain directory of markdown files (default ./memory), one
// subdirectory per project plus an org-wide shared/ space, each with its own
// MEMORY.md index. The server exposes the same core commands as Claude's
// memory tool — view, create, str_replace, insert, delete, rename. The model
// does the rest, exactly as Claude does natively: it keeps the index, one
// file per memory, and decides what deserves saving.
//
// Scoping: POST /mcp/<project> sandboxes a session to memory/<project>/ plus
// the read-write shared/ space; bare POST /mcp is the unscoped whole-vault
// (gardener) view.
//
// Env:
//   MEMORY_DIR   the memory folder (default ./memory)
//   VAULT_PORT   listen port on 127.0.0.1 (default 8787)
//
// MCP: stateless Streamable HTTP — POST one JSON-RPC message per request.
// Connect (per repo): claude mcp add --transport http --scope project vault http://localhost:8787/mcp/<project>

import { createServer } from "node:http";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename as fsRename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let MEMORY_DIR = resolve(process.env.MEMORY_DIR ?? "./memory");
const PORT = Number(process.env.VAULT_PORT ?? 8787);

// Several processes can share the store (stdio instances, the HTTP server),
// so every write lands via temp-file + rename — a reader never sees a torn file.
async function atomicWrite(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, data);
  await fsRename(tmp, path);
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "memory-vault", version: "0.3.1" };

const instructionsFor = (scope) =>
  scope
    ? `You have a persistent memory vault. This session's project space is "${scope}" — relative paths read and write there. MEMORY.md at its root is this project's index — view it before starting work, and read any memory file it points to that looks relevant. The whole vault is visible: other projects' spaces can be addressed by path ("<space>/<file>"), and the root listing shows every space.

Each memory is one markdown file holding one fact, with frontmatter (name: kebab-case slug, description: one-line summary), stored at the root of the directory. After writing a memory file, add or update its one-line pointer in MEMORY.md ("- [name](file.md) — hook"). Before saving, check whether an existing file already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong, and remove their index line.

The shared/ directory is org-wide memory visible to every project, with its own shared/MEMORY.md index — check it for relevant org facts, and store facts that apply beyond this project there (updating shared/MEMORY.md).

Store durable facts, corrections, lessons, and decisions — things that should outlive this session and be visible to every future session in every harness. Don't store what the repo or chat history already records.`
    : `You are viewing the whole memory vault. Each subdirectory is one project's memory space with its own MEMORY.md index; shared/ is org-wide memory visible to every project. The root MEMORY.md lists the spaces — view it and the relevant space's MEMORY.md before starting work.

Each memory is one markdown file holding one fact, with frontmatter (name: kebab-case slug, description: one-line summary). After writing a memory file, add or update its one-line pointer in that space's MEMORY.md ("- [name](file.md) — hook"). Before saving, check whether an existing file already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong, and remove their index line.

Store durable facts, corrections, lessons, and decisions — things that should outlive this session and be visible to every future session in every harness. Don't store what the repo or chat history already records.`;

// ── Path sandbox ──────────────────────────────────────────────────────────────

class ToolError extends Error {}

const scopeDir = (scope) => join(MEMORY_DIR, scope);
let SHARED_DIR = join(MEMORY_DIR, "shared");

// stdio mode resolves its store at startup (env → registry → ~/.memory-vault)
// rather than trusting the ./memory default, which is only right for `serve`
// run from the vault repo itself.
function setMemoryDir(dir) {
  MEMORY_DIR = resolve(dir);
  SHARED_DIR = join(MEMORY_DIR, "shared");
}
const under = (abs, root) => abs === root || abs.startsWith(root + sep);

// Scope is a routing default, not a wall (AJ's decision, 2026-08-22: every
// session sees the whole vault, no matter which directory the harness was
// opened in). Relative paths land in the session's own space; a path whose
// first segment names another space (or that already exists from the root)
// addresses that space directly. The only rejected paths are ones escaping
// the memory directory itself.
function resolvePath(p, scope) {
  if (typeof p !== "string" || !p.trim()) throw new ToolError("path is required");
  // Tolerate "/memories/foo.md" and "memories/foo.md" spellings.
  const cleaned = p.trim().replace(/^\/?(memories\/)?/, "");
  let abs;
  if (!scope) {
    abs = resolve(MEMORY_DIR, cleaned);
  } else {
    const fromScope = resolve(scopeDir(scope), cleaned);
    const fromRoot = resolve(MEMORY_DIR, cleaned);
    const firstSegment = cleaned.split("/")[0];
    const namesSpace =
      firstSegment && firstSegment !== "." && existsSync(join(MEMORY_DIR, firstSegment)) && !existsSync(fromScope);
    if (existsSync(fromScope)) abs = fromScope;
    else if (existsSync(fromRoot) || namesSpace) abs = fromRoot;
    else abs = fromScope;
  }
  if (!under(abs, MEMORY_DIR)) {
    throw new ToolError(`path escapes the memory directory: ${p}`);
  }
  return abs;
}

function rel(abs, scope) {
  if (scope && under(abs, scopeDir(scope))) return relative(scopeDir(scope), abs) || ".";
  return relative(MEMORY_DIR, abs) || ".";
}

// ── The six memory commands ───────────────────────────────────────────────────

const TOOLS = [
  {
    name: "view",
    description:
      "View a file or directory in the memory folder. Directories list their entries; files return numbered lines. Start every session by viewing MEMORY.md, the index.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the memory root ('.' for the root listing)" },
        view_range: {
          type: "array",
          items: { type: "number" },
          description: "Optional [start, end] line range (1-indexed, inclusive)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create",
    description:
      "Create or overwrite a file in the memory folder. Memories are markdown files with 'name:' and 'description:' frontmatter; after creating one, update MEMORY.md.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the memory root" },
        file_text: { type: "string", description: "Full file contents" },
      },
      required: ["path", "file_text"],
    },
  },
  {
    name: "str_replace",
    description:
      "Replace an exact string in a memory file. The old string must occur exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the memory root" },
        old_str: { type: "string", description: "Exact text to replace (must be unique in the file)" },
        new_str: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "insert",
    description: "Insert text after a given line in a memory file (0 = beginning of file).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the memory root" },
        insert_line: { type: "number", description: "Line number to insert after (0 = top)" },
        insert_text: { type: "string", description: "Text to insert" },
      },
      required: ["path", "insert_line", "insert_text"],
    },
  },
  {
    name: "delete",
    description:
      "Delete a file or directory in the memory folder. Remember to remove the memory's line from MEMORY.md.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the memory root" },
      },
      required: ["path"],
    },
  },
  {
    name: "rename",
    description: "Move or rename a file or directory within the memory folder.",
    inputSchema: {
      type: "object",
      properties: {
        old_path: { type: "string", description: "Current path relative to the memory root" },
        new_path: { type: "string", description: "New path relative to the memory root" },
      },
      required: ["old_path", "new_path"],
    },
  },
];

async function callTool(name, args, scope) {
  if (scope) await mkdir(scopeDir(scope), { recursive: true });
  switch (name) {
    case "view": {
      const abs = resolvePath(args.path, scope);
      const st = await stat(abs).catch(() => null);
      if (!st) throw new ToolError(`not found: ${args.path}`);
      if (st.isDirectory()) {
        const entries = await readdir(abs, { withFileTypes: true });
        const lines = entries
          .filter((e) => !e.name.startsWith("."))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        // A scoped session's root listing also shows the rest of the vault —
        // every space is visible; this one is just the write default.
        if (scope && abs === scopeDir(scope)) {
          const top = await readdir(MEMORY_DIR, { withFileTypes: true }).catch(() => []);
          const others = top
            .filter((e) => e.isDirectory() && e.name !== scope && !e.name.startsWith("."))
            .map((e) => `${e.name}/  (other space)`)
            .sort();
          const own = lines.join("\n") || "(no memories in this space yet)";
          return `Directory: . (space "${scope}")\n${own}${others.length ? `\n${others.join("\n")}` : ""}`;
        }
        return `Directory: ${rel(abs, scope)}\n${lines.join("\n") || "(empty)"}`;
      }
      const lines = (await readFile(abs, "utf8")).split("\n");
      let [start, end] = Array.isArray(args.view_range) ? args.view_range : [1, lines.length];
      start = Math.max(1, Number(start) || 1);
      end = Math.min(lines.length, Number(end) || lines.length);
      return lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(4)}: ${l}`)
        .join("\n");
    }

    case "create": {
      const abs = resolvePath(args.path, scope);
      if (typeof args.file_text !== "string") throw new ToolError("file_text is required");
      await mkdir(dirname(abs), { recursive: true });
      await atomicWrite(abs, args.file_text);
      return `Created ${rel(abs, scope)}`;
    }

    case "str_replace": {
      const abs = resolvePath(args.path, scope);
      const text = await readFile(abs, "utf8").catch(() => {
        throw new ToolError(`not found: ${args.path}`);
      });
      const { old_str: oldStr, new_str: newStr } = args;
      if (typeof oldStr !== "string" || typeof newStr !== "string") {
        throw new ToolError("old_str and new_str are required");
      }
      const count = text.split(oldStr).length - 1;
      if (count === 0) throw new ToolError("old_str not found in file");
      if (count > 1) throw new ToolError(`old_str occurs ${count} times — must be unique`);
      await atomicWrite(abs, text.replace(oldStr, newStr));
      return `Edited ${rel(abs, scope)}`;
    }

    case "insert": {
      const abs = resolvePath(args.path, scope);
      const text = await readFile(abs, "utf8").catch(() => {
        throw new ToolError(`not found: ${args.path}`);
      });
      const lines = text.split("\n");
      const at = Number(args.insert_line);
      if (!Number.isInteger(at) || at < 0 || at > lines.length) {
        throw new ToolError(`insert_line must be between 0 and ${lines.length}`);
      }
      lines.splice(at, 0, String(args.insert_text ?? ""));
      await atomicWrite(abs, lines.join("\n"));
      return `Inserted into ${rel(abs, scope)} after line ${at}`;
    }

    case "delete": {
      const abs = resolvePath(args.path, scope);
      if (abs === MEMORY_DIR || dirname(abs) === MEMORY_DIR) {
        throw new ToolError("refusing to delete the memory root or a space root");
      }
      const st = await stat(abs).catch(() => null);
      if (!st) throw new ToolError(`not found: ${args.path}`);
      await rm(abs, { recursive: true });
      return `Deleted ${rel(abs, scope)}`;
    }

    case "rename": {
      const from = resolvePath(args.old_path, scope);
      const to = resolvePath(args.new_path, scope);
      if (!(await stat(from).catch(() => null))) throw new ToolError(`not found: ${args.old_path}`);
      await mkdir(dirname(to), { recursive: true });
      await fsRename(from, to);
      return `Renamed ${rel(from, scope)} → ${rel(to, scope)}`;
    }

    default:
      throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
  }
}

// ── JSON-RPC / MCP dispatch ───────────────────────────────────────────────────

class JsonRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function dispatch(method, params, scope, scopeNote) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: scopeNote ? `${instructionsFor(scope)}\n\n${scopeNote}` : instructionsFor(scope),
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      if (typeof params?.name !== "string") {
        throw new JsonRpcError(-32602, "tools/call requires a tool name");
      }
      try {
        const text = await callTool(params.name, params.arguments ?? {}, scope);
        return { content: [{ type: "text", text }], isError: false };
      } catch (err) {
        if (err instanceof JsonRpcError) throw err;
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    }
    default:
      throw new JsonRpcError(-32601, `Method not found: ${method}`);
  }
}

// ── HTTP server (127.0.0.1 only) ──────────────────────────────────────────────

const rpcJson = (id, payload) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...payload });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      `memory-vault (local) — store: ${MEMORY_DIR}\n` +
        `MCP endpoints: POST /mcp/<project> (project scope), POST /mcp (whole vault)\n` +
        `Connect (per repo): claude mcp add --transport http --scope project vault http://localhost:${PORT}/mcp/<project>\n`,
    );
    return;
  }
  const scopeMatch = url.pathname.match(/^\/mcp(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?$/);
  if (!scopeMatch) {
    res.writeHead(404).end("Not found");
    return;
  }
  const scope = scopeMatch[1]?.toLowerCase();
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  let message;
  try {
    message = JSON.parse(body);
  } catch {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcJson(null, { error: { code: -32700, message: "Parse error" } }));
    return;
  }
  if (Array.isArray(message) || typeof message !== "object" || message === null) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcJson(null, { error: { code: -32600, message: "Expected a single JSON-RPC message" } }));
    return;
  }
  if (message.id === undefined || message.id === null) {
    res.writeHead(202).end(); // notification
    return;
  }

  try {
    const result = await dispatch(message.method, message.params, scope);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcJson(message.id, { result }));
  } catch (err) {
    const code = err instanceof JsonRpcError ? err.code : -32603;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcJson(message.id, { error: { code, message: err.message } }));
  }
});

// ── connect — wire the current repo to the vault ──────────────────────────────
//
// One command replaces the setup recipe: make sure the server is up, then for
// each harness present write both layers it needs — the MCP registration in
// its own config format, and the memory ritual in a rules file it loads.

const SELF = fileURLToPath(import.meta.url);
const exists = (p) => stat(p).then(() => true, () => false);

const MEMORY_SECTION = `## Memory

This repo uses the vault MCP server (\`vault\`) for persistent memory. At session start, view \`MEMORY.md\` with the vault tools and read any entries relevant to the task. Before finishing, save durable facts, corrections, lessons, and decisions to the vault — one markdown file per fact with \`name:\`/\`description:\` frontmatter — and add or update its line in \`MEMORY.md\`. Check whether an existing memory already covers it before creating a new one. Facts that apply beyond this project go in \`shared/\` (update \`shared/MEMORY.md\`). Prefer the vault over any built-in auto-memory.
`;

// Markers around the written section let uninstall remove it verbatim even if
// the section text changes in a future version. (Sections written before the
// markers existed are removed by exact-text match instead.)
const MARK_BEGIN = "<!-- memory-vault:begin -->";
const MARK_END = "<!-- memory-vault:end -->";
const MARKED_SECTION = `${MARK_BEGIN}\n${MEMORY_SECTION}${MARK_END}\n`;

// The user-global ritual differs from the repo one: no fixed project name
// (stdio scopes each session automatically) and it points at per-repo install
// only as the opt-out for a custom space name.
const GLOBAL_MEMORY_SECTION = `## Memory

A memory-vault MCP server (\`vault\`) provides persistent cross-session memory; when its tools are available, prefer them over any built-in auto-memory. Memories are scoped to a per-project space automatically (detected from the session's directory); \`shared/\` is cross-project memory visible everywhere. At session start, view \`MEMORY.md\` with the vault tools and read any entries relevant to the task; also check \`shared/MEMORY.md\`. Before finishing, save durable facts, corrections, lessons, and decisions — one markdown file per fact with \`name:\`/\`description:\` frontmatter — and add or update its line in \`MEMORY.md\`. Check whether an existing memory already covers it before creating a new one; delete memories that turn out to be wrong. Don't store what the repo or chat history already records.
`;
const GLOBAL_MARKED_SECTION = `${MARK_BEGIN}\n${GLOBAL_MEMORY_SECTION}${MARK_END}\n`;

// Cursor has no writable always-on rules file, but it loads personal skills
// from ~/.cursor/skills/ — so the ritual ships as a skill with a broad
// trigger description. On-demand, not guaranteed-injected; the report still
// points at Settings → Rules for the always-on variant.
const CURSOR_RITUAL_SKILL = `---
name: memory-vault
description: >-
  Persistent cross-session memory via the vault MCP server. Use at the start
  of any coding task to recall project memory and context from previous
  sessions, whenever the user mentions remembering, memory, or past
  decisions, and before finishing work to save durable facts, corrections,
  lessons, and decisions.
---
# Memory Vault

A memory-vault MCP server (\`vault\`) provides persistent cross-session memory shared across coding agents. Memories are scoped to a per-project space automatically (detected from the session's directory); \`shared/\` is cross-project memory visible everywhere.

At the start of a task: view \`MEMORY.md\` with the vault tools and read any entries relevant to the task; also check \`shared/MEMORY.md\`.

Before finishing: save durable facts, corrections, lessons, and decisions — one markdown file per fact with \`name:\`/\`description:\` frontmatter — and add or update its line in \`MEMORY.md\`. Check whether an existing memory already covers it before creating a new one; delete memories that turn out to be wrong. Don't store what the repo or chat history already records.
`;

// Append the global ritual to one harness's user-global rules file. The file's
// parent directory must already exist (the caller detects the harness first);
// a file that already mentions the vault is left alone.
async function upsertGlobalRules(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw !== null && /vault/i.test(raw)) return "unchanged (already mentions the vault)";
  if (!dryRun) await writeFile(path, raw === null ? GLOBAL_MARKED_SECTION : `${raw.trimEnd()}\n\n${GLOBAL_MARKED_SECTION}`);
  return raw === null ? "created with the memory section" : "memory section appended";
}

async function removeGlobalRules(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return "not present";
  const marked = /(?:^|\n)<!-- memory-vault:begin -->\n[\s\S]*?<!-- memory-vault:end -->\n?/;
  if (!marked.test(raw)) {
    return /vault/i.test(raw) ? "mentions the vault but not the managed section — edit by hand" : "no memory section";
  }
  const cleaned = raw.replace(marked, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned === "") {
    if (!dryRun) await rm(path);
    return "deleted (only held the memory section)";
  }
  if (!dryRun) await writeFile(path, cleaned + "\n");
  return "memory section removed";
}

const projectSlug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);

// Machine-level record of this machine's wiring — advisory, not authoritative
// (repos move and vanish), so readers treat entries as hints. Lives outside
// the store: it describes wiring, not memories. Fields: connections (repos
// that ran per-repo install), store (the store path recorded by install
// --global, so stdio instances find it without env), spaces (project root →
// space name, written by stdio auto-detection so renames and basename
// collisions stay stable), global (what install --global wired).
const CONNECTIONS_PATH = join(homedir(), ".memory-vault-connections.json");

async function readRegistry() {
  try {
    const parsed = JSON.parse(await readFile(CONNECTIONS_PATH, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeRegistry(registry) {
  await atomicWrite(CONNECTIONS_PATH, JSON.stringify(registry, null, 2) + "\n");
}

async function readConnections() {
  const registry = await readRegistry();
  return Array.isArray(registry.connections) ? registry.connections : [];
}

async function writeConnections(connections) {
  const registry = await readRegistry();
  registry.connections = connections;
  await writeRegistry(registry);
}

// ── stdio scope detection ─────────────────────────────────────────────────────
//
// A stdio instance is spawned by the harness in the session's directory, so
// the working directory is the one signal that identifies the project — walk
// up to the first .git (or, failing that, the shallowest package manifest)
// and name the space after that directory.

async function findProjectRoot(cwd) {
  let dir = resolve(cwd);
  let manifestRoot = null;
  while (true) {
    if (await exists(join(dir, ".git"))) return dir;
    if (await exists(join(dir, "package.json")) || (await exists(join(dir, "pyproject.toml")))) manifestRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) return manifestRoot;
    dir = parent;
  }
}

async function resolveSpace(cwd) {
  const root = await findProjectRoot(cwd);
  if (root === null) return "default";
  const registry = await readRegistry();
  registry.spaces ??= {};
  if (typeof registry.spaces[root] === "string") return registry.spaces[root];
  // "shared" is the org-wide space; a project that happens to carry that name
  // must not scope onto it.
  const taken = new Set(["shared", ...Object.values(registry.spaces)]);
  let space = projectSlug(basename(root)) || "default";
  for (let i = 2; taken.has(space); i++) space = `${projectSlug(basename(root))}-${i}`;
  registry.spaces[root] = space;
  await writeRegistry(registry);
  return space;
}

async function serverUp() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

// Merge one entry into a { mcpServers: { ... } } JSON config, preserving the
// rest of the file. Returns "created" | "updated" | "unchanged".
async function mergeMcpJson(path, entry, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  let config = {};
  if (raw !== null) {
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error(`${path} is not valid JSON — fix it or add the vault entry by hand`);
    }
  }
  config.mcpServers ??= {};
  if (JSON.stringify(config.mcpServers.vault) === JSON.stringify(entry)) return "unchanged";
  const status = raw === null ? "created" : "updated";
  config.mcpServers.vault = entry;
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return status;
}

// Reverse of mergeMcpJson: drop the vault entry, delete the file if that was
// all it held. Returns a status string for the report.
async function removeMcpJson(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return "not present";
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return "not valid JSON — remove the vault entry by hand";
  }
  if (!config.mcpServers?.vault) return "no vault entry";
  delete config.mcpServers.vault;
  const empty = Object.keys(config).length === 1 && Object.keys(config.mcpServers).length === 0;
  if (!dryRun) {
    if (empty) await rm(path);
    else await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return empty ? "deleted (only held the vault entry)" : "vault entry removed";
}

// opencode's config nests servers under "mcp" (not "mcpServers"), so it gets
// its own merge/remove pair with the same created/updated/unchanged contract.
async function mergeOpencodeMcp(path, entry, dryRun) {
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
  if (JSON.stringify(config.mcp.vault) === JSON.stringify(entry)) return "unchanged";
  const status = raw === null ? "created" : "updated";
  config.mcp.vault = entry;
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return status;
}

async function removeOpencodeMcp(path, dryRun) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return "not present";
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return "not valid JSON — remove the vault entry by hand";
  }
  if (!config.mcp?.vault) return "no vault entry";
  delete config.mcp.vault;
  const empty = Object.keys(config).every((k) => k === "mcp" || k === "$schema") && Object.keys(config.mcp).length === 0;
  if (!dryRun) {
    if (empty) await rm(path);
    else await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return empty ? "deleted (only held the vault entry)" : "vault entry removed";
}

// ── harness registry ──────────────────────────────────────────────────────────
//
// Each harness owns three hooks: detect (is it on this machine / in this
// repo), install (write its MCP registration), and uninstall (remove exactly
// what install wrote, leaving the repo as it was). The shared rules files
// (AGENTS.md + CLAUDE.md) are a separate step because every harness reads the
// same ritual text. Adding a harness = adding one entry here.

const HARNESSES = [
  {
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
  },
  {
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
  },
  {
    key: "codex",
    title: "Codex CLI",
    where: ".codex/config.toml",
    detect: async (cwd) => (await exists(join(homedir(), ".codex"))) || (await exists(join(cwd, ".codex"))),
    async install({ cwd, url, dryRun }) {
      // Project-scoped Codex config (trusted projects). TOML is appended, not
      // parsed — if a vault block already exists we only verify the URL.
      const tomlPath = join(cwd, ".codex", "config.toml");
      const toml = await readFile(tomlPath, "utf8").catch(() => null);
      if (toml === null || !toml.includes("[mcp_servers.vault]")) {
        if (!dryRun) {
          await mkdir(dirname(tomlPath), { recursive: true });
          await writeFile(tomlPath, `${toml?.trimEnd() ? toml.trimEnd() + "\n\n" : ""}[mcp_servers.vault]\nurl = "${url}"\n`);
        }
        return [`codex    .codex/config.toml ${toml === null ? "created" : "updated"} (trusted projects only)`];
      }
      return [
        toml.includes(`url = "${url}"`)
          ? "codex    .codex/config.toml unchanged"
          : `codex    .codex/config.toml already has a vault entry with a different url — update it by hand to ${url}`,
      ];
    },
    async uninstall({ cwd, dryRun }) {
      const tomlPath = join(cwd, ".codex", "config.toml");
      const toml = await readFile(tomlPath, "utf8").catch(() => null);
      if (toml === null) return ["codex    .codex/config.toml not present"];
      if (!toml.includes("[mcp_servers.vault]")) return ["codex    .codex/config.toml no vault entry"];
      // Also strip [mcp_servers.vault.*] sub-tables (per-tool approval modes).
      // Multiline ^ so consecutive blocks match — a match consumes the newline
      // the next block would otherwise need as its (?:^|\n) anchor.
      const cleaned = toml.replace(/^\[mcp_servers\.vault(?:\.[^\]]+)?\]\n(?:(?!\[).*(?:\n|$))*/gm, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
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
        const block = `[mcp_servers.vault]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenv = { MEMORY_DIR = ${JSON.stringify(store)} }\n`;
        if (!dryRun) await writeFile(tomlPath, `${toml?.trimEnd() ? toml.trimEnd() + "\n\n" : ""}${block}`);
        lines.push(`codex    ~/.codex/config.toml ${toml === null ? "created" : "updated"} (global, stdio)`);
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
      else if (!toml.includes("[mcp_servers.vault")) lines.push("codex    ~/.codex/config.toml no vault entry");
      else {
        const cleaned = toml.replace(/^\[mcp_servers\.vault(?:\.[^\]]+)?\]\n(?:(?!\[).*(?:\n|$))*/gm, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
        if (!dryRun) await writeFile(tomlPath, cleaned.trimEnd() + "\n");
        lines.push("codex    ~/.codex/config.toml vault entry removed");
      }
      lines.push(`codex    ~/.codex/AGENTS.md ${await removeGlobalRules(join(homedir(), ".codex", "AGENTS.md"), dryRun)}`);
      return lines;
    },
  },
  {
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
  },
  {
    key: "opencode",
    title: "opencode",
    where: "opencode.json",
    detect: async (cwd) =>
      (await exists(join(homedir(), ".opencode"))) ||
      (await exists(join(homedir(), ".config", "opencode"))) ||
      exists(join(cwd, "opencode.json")),
    // Repo level: opencode reads a project opencode.json; the HTTP server is
    // addressed as a "remote" MCP entry.
    async install({ cwd, url, dryRun }) {
      const status = await mergeOpencodeMcp(join(cwd, "opencode.json"), { type: "remote", url, enabled: true }, dryRun);
      return [`opencode opencode.json ${status} (vault → ${url})`];
    },
    async uninstall({ cwd, dryRun }) {
      return [`opencode opencode.json ${await removeOpencodeMcp(join(cwd, "opencode.json"), dryRun)}`];
    },
    // Global: ~/.config/opencode/opencode.json ("local" = stdio, command is a
    // single array) + the global rules file ~/.config/opencode/AGENTS.md.
    // opencode also falls back to ~/.claude/CLAUDE.md when its own global
    // rules file is absent, so writing ours must carry the full ritual.
    async globalInstall({ store, command, args, dryRun }) {
      if (!(await exists(join(homedir(), ".opencode"))) && !(await exists(join(homedir(), ".config", "opencode")))) {
        return ["opencode ~/.opencode not found — skipped"];
      }
      const configDir = join(homedir(), ".config", "opencode");
      const entry = { type: "local", command: [command, ...args], enabled: true, environment: { MEMORY_DIR: store } };
      const status = await mergeOpencodeMcp(join(configDir, "opencode.json"), entry, dryRun);
      if (!dryRun) await mkdir(configDir, { recursive: true });
      const rules = dryRun && !(await exists(configDir)) ? "would create with the memory section" : await upsertGlobalRules(join(configDir, "AGENTS.md"), dryRun);
      return [`opencode ~/.config/opencode/opencode.json ${status} (global, stdio)`, `opencode ~/.config/opencode/AGENTS.md ${rules}`];
    },
    async globalUninstall({ dryRun }) {
      const configDir = join(homedir(), ".config", "opencode");
      if (!(await exists(configDir))) return ["opencode ~/.config/opencode not found — skipped"];
      return [
        `opencode ~/.config/opencode/opencode.json ${await removeOpencodeMcp(join(configDir, "opencode.json"), dryRun)}`,
        `opencode ~/.config/opencode/AGENTS.md ${await removeGlobalRules(join(configDir, "AGENTS.md"), dryRun)}`,
      ];
    },
  },
  {
    key: "gemini",
    title: "Gemini CLI",
    where: ".gemini/settings.json",
    detect: async (cwd) => (await exists(join(homedir(), ".gemini"))) || exists(join(cwd, ".gemini")),
    // Same "mcpServers" key as Claude's configs, so mergeMcpJson applies;
    // repo level addresses the HTTP server via Gemini's httpUrl field.
    async install({ cwd, url, dryRun }) {
      const status = await mergeMcpJson(join(cwd, ".gemini", "settings.json"), { httpUrl: url }, dryRun);
      return [`gemini   .gemini/settings.json ${status} (vault → ${url})`];
    },
    async uninstall({ cwd, dryRun }) {
      const status = await removeMcpJson(join(cwd, ".gemini", "settings.json"), dryRun);
      if (!dryRun && status.startsWith("deleted")) await rmdir(join(cwd, ".gemini")).catch(() => {});
      return [`gemini   .gemini/settings.json ${status}`];
    },
    // Global: ~/.gemini/settings.json (stdio: command/args/env) + the global
    // context file ~/.gemini/GEMINI.md.
    async globalInstall({ store, command, args, dryRun }) {
      if (!(await exists(join(homedir(), ".gemini")))) return ["gemini   ~/.gemini not found — skipped"];
      const entry = { command, args, env: { MEMORY_DIR: store } };
      const status = await mergeMcpJson(join(homedir(), ".gemini", "settings.json"), entry, dryRun);
      const rules = await upsertGlobalRules(join(homedir(), ".gemini", "GEMINI.md"), dryRun);
      return [`gemini   ~/.gemini/settings.json ${status} (global, stdio)`, `gemini   ~/.gemini/GEMINI.md ${rules}`];
    },
    async globalUninstall({ dryRun }) {
      if (!(await exists(join(homedir(), ".gemini")))) return ["gemini   ~/.gemini not found — skipped"];
      return [
        `gemini   ~/.gemini/settings.json ${await removeMcpJson(join(homedir(), ".gemini", "settings.json"), dryRun)}`,
        `gemini   ~/.gemini/GEMINI.md ${await removeGlobalRules(join(homedir(), ".gemini", "GEMINI.md"), dryRun)}`,
      ];
    },
  },
];

// Profile directories under ~/.dsh/profiles that are real profiles (they
// carry a cordis.yml) — node_modules and stray files are skipped.
async function dshProfiles() {
  const root = join(homedir(), ".dsh", "profiles");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const e of entries) {
    if (e.isDirectory() && (await exists(join(root, e.name, "cordis.yml")))) profiles.push(e.name);
  }
  return profiles.sort();
}

// The ritual. AGENTS.md carries it (Codex, Cursor, and the growing
// cross-harness convention); CLAUDE.md imports it via @AGENTS.md so the
// text lives in one place.
async function installRules({ cwd, project, dryRun }) {
  const lines = [];
  const agentsPath = join(cwd, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8").catch(() => null);
  if (agents === null) {
    if (!dryRun) await writeFile(agentsPath, `# ${project}\n\n${MARKED_SECTION}`);
    lines.push("rules    AGENTS.md created with the memory section");
  } else if (!/vault/i.test(agents)) {
    if (!dryRun) await writeFile(agentsPath, `${agents.trimEnd()}\n\n${MARKED_SECTION}`);
    lines.push("rules    AGENTS.md memory section appended");
  } else {
    lines.push("rules    AGENTS.md unchanged");
  }

  const claudeMdPath = join(cwd, "CLAUDE.md");
  const claudeMd = await readFile(claudeMdPath, "utf8").catch(() => null);
  if (claudeMd === null) {
    if (!dryRun) await writeFile(claudeMdPath, "@AGENTS.md\n");
    lines.push("rules    CLAUDE.md created (imports @AGENTS.md)");
  } else if (!/vault/i.test(claudeMd) && !claudeMd.includes("@AGENTS.md")) {
    if (!dryRun) await writeFile(claudeMdPath, `${claudeMd.trimEnd()}\n\n@AGENTS.md\n`);
    lines.push("rules    CLAUDE.md @AGENTS.md import appended");
  } else {
    lines.push("rules    CLAUDE.md unchanged");
  }
  return lines;
}

async function uninstallRules({ cwd, project, dryRun }) {
  const lines = [];
  const agentsPath = join(cwd, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8").catch(() => null);
  let sectionRemoved = false;
  let agentsDeleted = false;
  if (agents === null) {
    lines.push("rules    AGENTS.md not present");
  } else {
    // Marker-delimited sections first (written by install going forward),
    // exact text of the current section as fallback for older installs.
    const marked = /(?:^|\n)<!-- memory-vault:begin -->\n[\s\S]*?<!-- memory-vault:end -->\n?/;
    let cleaned = null;
    if (marked.test(agents)) cleaned = agents.replace(marked, "\n");
    else if (agents.includes(MEMORY_SECTION)) cleaned = agents.replace(MEMORY_SECTION, "");
    if (cleaned === null) {
      lines.push(
        /vault/i.test(agents)
          ? "rules    AGENTS.md mentions the vault but not the standard section — edit by hand"
          : "rules    AGENTS.md no memory section",
      );
    } else {
      sectionRemoved = true;
      const rest = cleaned.trim();
      if (rest === "" || rest === `# ${project}`) {
        if (!dryRun) await rm(agentsPath);
        agentsDeleted = true;
        lines.push("rules    AGENTS.md deleted (only held the memory section)");
      } else {
        if (!dryRun) await writeFile(agentsPath, cleaned.replace(/\n{3,}/g, "\n\n").trim() + "\n");
        lines.push("rules    AGENTS.md memory section removed");
      }
    }
  }

  const claudeMdPath = join(cwd, "CLAUDE.md");
  const claudeMd = await readFile(claudeMdPath, "utf8").catch(() => null);
  if (claudeMd === null) {
    lines.push("rules    CLAUDE.md not present");
  } else if (claudeMd.trim() === "@AGENTS.md" && (agentsDeleted || sectionRemoved)) {
    if (!dryRun) await rm(claudeMdPath);
    lines.push("rules    CLAUDE.md deleted (only imported AGENTS.md)");
  } else if ((agentsDeleted || sectionRemoved) && /\n@AGENTS\.md\s*$/.test(claudeMd)) {
    if (!dryRun) await writeFile(claudeMdPath, claudeMd.replace(/\n+@AGENTS\.md\s*$/, "\n"));
    lines.push("rules    CLAUDE.md @AGENTS.md import removed");
  } else if (/vault/i.test(claudeMd)) {
    lines.push("rules    CLAUDE.md mentions the vault — review by hand");
  } else {
    lines.push("rules    CLAUDE.md unchanged");
  }
  return lines;
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

// ── stdio transport ───────────────────────────────────────────────────────────
//
// MCP over stdin/stdout, newline-delimited JSON-RPC, one scope for the whole
// process: the harness spawns us in the session's directory, and that cwd
// names the project space. Nothing but protocol may touch stdout here.

async function stdioServe() {
  const registry = await readRegistry();
  setMemoryDir(process.env.MEMORY_DIR ?? registry.store ?? join(homedir(), ".memory-vault"));
  await mkdir(MEMORY_DIR, { recursive: true });
  const cwd = process.cwd();
  const scope = await resolveSpace(cwd);
  // Sessions in a non-project directory land in the fallback space. Explain
  // that in the handshake instructions — the session can then tell its user
  // which folder to open instead of reporting the vault as unreadable.
  let scopeNote;
  if (scope === "default") {
    const entries = await readdir(MEMORY_DIR, { withFileTypes: true }).catch(() => []);
    const spaces = entries
      .filter((e) => e.isDirectory() && e.name !== "default" && e.name !== "shared" && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    scopeNote =
      `Scope note: this session's directory (${cwd}) is not inside a project (no .git or package manifest found), ` +
      `so relative paths default to the "default" space. The whole vault is still visible: ` +
      (spaces.length > 0
        ? `project spaces on this machine are ${spaces.join(", ")} — address them by path ("<space>/MEMORY.md"). ` +
          `Save project-specific facts in the matching project's space, cross-project facts in shared/.`
        : `no project spaces exist yet; they are created automatically when a session runs inside a project directory.`);
  } else {
    scopeNote = `Scope note: space "${scope}" was auto-detected from ${cwd}; other spaces remain addressable by path.`;
  }
  const respond = (id, payload) => process.stdout.write(rpcJson(id, payload) + "\n");
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        respond(null, { error: { code: -32700, message: "Parse error" } });
        continue;
      }
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        respond(null, { error: { code: -32600, message: "Expected a single JSON-RPC message" } });
        continue;
      }
      if (message.id === undefined || message.id === null) continue; // notification
      try {
        const result = await dispatch(message.method, message.params, scope, scopeNote);
        respond(message.id, { result });
      } catch (err) {
        respond(message.id, { error: { code: err instanceof JsonRpcError ? err.code : -32603, message: err.message } });
      }
    }
  }
}

// ── CLI dispatch ──────────────────────────────────────────────────────────────

// status — the three-layer diagnosis: server up? repo wired? and if both,
// the remaining failure mode is session attachment, which only a session
// restart / approval can fix, so say exactly that.
async function status() {
  const cwd = process.cwd();
  console.log("memory-vault status\n");

  let banner = null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    banner = (await res.text()).trim().split("\n")[0];
  } catch {}
  console.log(
    banner !== null
      ? `  server   up on port ${PORT} — ${banner}`
      : `  server   down (port ${PORT}) — start it: npx memory-vault install (or serve)`,
  );

  console.log(`\n  this repo (${cwd}):`);
  for (const h of HARNESSES) {
    const raw = await readFile(join(cwd, h.where), "utf8").catch(() => null);
    const state = raw === null ? "not present" : /vault/i.test(raw) ? "wired" : "present, no vault entry";
    console.log(`  ${h.key.padEnd(9)}${h.where} ${state}`);
  }
  const agents = await readFile(join(cwd, "AGENTS.md"), "utf8").catch(() => null);
  console.log(
    `  rules    AGENTS.md ${agents === null ? "not present" : /vault/i.test(agents) ? "has the memory section" : "no memory section"}`,
  );

  const registry = await readRegistry();
  const home = homedir();
  console.log("\n  global (install --global):");
  const mcpWired = async (path) => {
    try {
      return JSON.parse(await readFile(path, "utf8")).mcpServers?.vault ? "wired" : "present, no vault entry";
    } catch {
      return "not present";
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
  memory-vault status       show server state, this repo's wiring, the global
                            wiring, and every repo recorded by install`;

const cmd = process.argv[2];
const rest = process.argv.slice(3);
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
