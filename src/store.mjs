// Memory engine — the store directory, the path sandbox, and the six memory
// commands. Everything else in src/ is transport or wiring around this.

import { mkdir, readdir, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export let MEMORY_DIR = resolve(process.env.MEMORY_DIR ?? "./memory");
export const PORT = Number(process.env.VAULT_PORT ?? 8787);

// Several processes can share the store (stdio instances, the HTTP server),
// so every write lands via temp-file + rename — a reader never sees a torn file.
export async function atomicWrite(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, data);
  await fsRename(tmp, path);
}

export const exists = (p) => stat(p).then(() => true, () => false);

// ── Path sandbox ──────────────────────────────────────────────────────────────

export class ToolError extends Error {}

export class JsonRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const scopeDir = (scope) => join(MEMORY_DIR, scope);
let SHARED_DIR = join(MEMORY_DIR, "shared");

// stdio mode resolves its store at startup (env → registry → ~/.memory-vault)
// rather than trusting the ./memory default, which is only right for `serve`
// run from the vault repo itself.
export function setMemoryDir(dir) {
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

export const TOOLS = [
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

export async function callTool(name, args, scope) {
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
