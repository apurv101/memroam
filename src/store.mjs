// Memory engine — the store directory, the path sandbox, and the six memory
// commands. Everything else in src/ is transport or wiring around this.

import { mkdir, readdir, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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

// ── Generated MEMORY.md (S1) ──────────────────────────────────────────────────
//
// Each space's MEMORY.md is a deterministic projection of its files'
// frontmatter, regenerated after every successful mutation in that space.
// Direct edits to an index are refused — the description: field IS the index
// line, so the index can never disagree with the files.

const INDEX_FILE = "MEMORY.md";
const isIndex = (abs) => basename(abs) === INDEX_FILE;

export function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = text.slice(4, end);
  const get = (key) => block.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"))?.[1].trim();
  return { name: get("name"), description: get("description") };
}

// Pure index projection, shared with the hosted (GitHub-backed) store so the
// two can never disagree on MEMORY.md's format.
export function indexRow(fileName, text) {
  const fm = parseFrontmatter(text);
  return fm?.name && fm?.description
    ? { key: fm.name, line: `- [${fm.name}](${fileName}) — ${fm.description}` }
    : { key: fileName, line: `- [${fileName}](${fileName}) — ⚠ no frontmatter` };
}

export function indexContent(space, rows) {
  rows.sort((a, b) => a.key.localeCompare(b.key));
  const title = space === "shared" ? "# shared — org-wide memory index" : `# ${space} — memory index`;
  const body = rows.length ? rows.map((r) => r.line).join("\n") : "(no memories in this space yet)";
  return `${title}\n\n${body}\n`;
}

export async function regenerateIndex(space) {
  const dir = join(MEMORY_DIR, space);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return; // space no longer exists — nothing to index
  const rows = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name === INDEX_FILE || e.name.startsWith(".")) continue;
    rows.push(indexRow(e.name, await readFile(join(dir, e.name), "utf8").catch(() => "")));
  }
  await atomicWrite(join(dir, INDEX_FILE), indexContent(space, rows));
}

// Regenerate the index of every space a mutation touched. A path directly at
// the memory root belongs to no space and is skipped.
async function reindexFor(...paths) {
  const spaces = new Set();
  for (const abs of paths) {
    const segs = relative(MEMORY_DIR, abs).split(sep);
    if (segs.length >= 2 && segs[0] && segs[0] !== ".." && !segs[0].startsWith(".")) spaces.add(segs[0]);
  }
  for (const space of spaces) await regenerateIndex(space);
}

const INDEX_EDIT_ERROR =
  "MEMORY.md is generated from each memory file's frontmatter — it can't be edited directly. Edit the memory file's description: instead; the index regenerates automatically.";

// ── Identity (S3) ─────────────────────────────────────────────────────────────
//
// Every memory file gets an immutable UUIDv7 `id:` at creation — the server
// stamps it when the frontmatter lacks one, so no file class without identity
// ever exists. The slug/filename stays mutable; rename never touches id.

export function uuidv7() {
  const b = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Insert `id:` as the first frontmatter key when the block lacks one. Files
// without a frontmatter block are left alone (they're flagged in the index).
// Exported for the adapters, which write candidate files directly.
export function stampId(text) {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return text;
  if (/^id:/m.test(text.slice(4, end))) return text;
  return `---\nid: ${uuidv7()}\n${text.slice(4)}`;
}

// ── Candidates (S4) ───────────────────────────────────────────────────────────
//
// The two-door model: direct instruction-driven saves go straight to a
// space's root (canonical — today's ritual, unchanged); passive/imported
// observations land in <space>/candidates/, one file per observation with
// id:, a capture-time scalar source:, and status: pending|promoted|superseded
// (adapters write these — see src/adapters/). Candidates are excluded from
// the generated MEMORY.md (the index scans only the space root) but show up
// in search, labeled. They are never silently deleted: the gardener marks
// them promoted/superseded and may archive superseded ones later.
const isCandidate = (relPath) => relPath.split("/").includes("candidates");

// Pure per-file scorer, shared with the hosted store: returns a hit for the
// results list, or null when no term matches. `path` is the vault-relative
// path used for display and tie-break ordering.
export function scoreMemory(path, fileName, text, terms) {
  const fm = parseFrontmatter(text) ?? {};
  const fmName = fm.name ?? "";
  const description = fm.description ?? "";
  const nameHay = `${fmName} ${fileName}`.toLowerCase();
  const descHay = description.toLowerCase();
  const bodyHay = text.toLowerCase();
  let matched = 0;
  let score = 0;
  for (const t of terms) {
    const inName = nameHay.includes(t);
    const inDesc = descHay.includes(t);
    const inBody = bodyHay.includes(t);
    if (!inName && !inDesc && !inBody) continue;
    matched++;
    score += (inName ? 5 : 0) + (inDesc ? 3 : 0) + (inBody ? 1 : 0);
  }
  if (matched === 0) return null;
  let snippet = "";
  const lines = text.split("\n");
  outer: for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    for (const t of terms) {
      if (line.includes(t)) {
        snippet = `${i + 1}: ${lines[i].trim()}`;
        break outer;
      }
    }
  }
  return { path, name: fmName, description, matched, score, snippet };
}

const MAX_RESULTS = 20;
const sortHits = (hits) =>
  hits.sort((a, b) => b.matched - a.matched || b.score - a.score || a.path.localeCompare(b.path));

export function renderSearch(hits, query, where) {
  sortHits(hits);
  if (hits.length === 0) return `No matches for "${query}" ${where}.`;
  const rows = hits.slice(0, MAX_RESULTS).map((h) => {
    const tag = isCandidate(h.path) ? "[candidate] " : "";
    const head = `${tag}${h.path}${h.name ? ` — ${h.name}` : ""}${h.description ? `: ${h.description}` : ""}`;
    return h.snippet ? `${head}\n    ${h.snippet}` : head;
  });
  const capNote =
    hits.length > MAX_RESULTS ? `\n(${hits.length - MAX_RESULTS} more matches not shown — refine the query)` : "";
  return `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" ${where}\n\n${rows.join("\n")}${capNote}`;
}

// OpenAI-connector search shape ({results: [{id, title, url}]}): same ordering
// and cap as renderSearch. `url` must be non-empty for ChatGPT to cite a
// result — the hosted store passes GitHub blob URLs; local stores have no web
// URL and pass nothing.
export function searchResultsPayload(hits, toUrl = () => "") {
  return {
    results: sortHits(hits)
      .slice(0, MAX_RESULTS)
      .map((h) => ({
        id: h.path,
        title: [h.name || h.path.split("/").pop(), h.description].filter(Boolean).join(": "),
        url: toUrl(h.path),
      })),
  };
}

// OpenAI-connector fetch shape for one memory file.
export function fetchPayload(path, text, url = "") {
  const fm = parseFrontmatter(text) ?? {};
  return {
    id: path,
    title: fm.name || path.split("/").pop(),
    text,
    url,
    metadata: fm.description ? { description: fm.description } : {},
  };
}

// ── search (S2) ───────────────────────────────────────────────────────────────
//
// Grep-tier by design: scan on demand, no index files, no embeddings.
// MEMORY.md files are skipped — they are indexes over the same content.
async function collectMarkdown(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await collectMarkdown(abs, out);
    else if (e.name.endsWith(".md") && e.name !== INDEX_FILE) out.push(abs);
  }
}

// ── The memory commands ───────────────────────────────────────────────────

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
    annotations: { readOnlyHint: true },
  },
  {
    name: "search",
    description:
      "Search memories by keyword across the whole vault — frontmatter and body, all spaces. Returns matching files ranked by relevance with the first matching line. Use this to find memories when you don't know the path; view is for reading known paths.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for (case-insensitive, matched independently)" },
        space: { type: "string", description: "Optional: restrict the search to one space (e.g. 'shared')" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fetch",
    description:
      "Fetch one memory file in full by its id — the vault-relative path that search results and MEMORY.md entries use (e.g. 'shared/some-memory.md'). Returns the complete contents.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory's id: its path relative to the memory root" },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create",
    description:
      "Create a file in the memory folder. Memories are markdown files with 'name:' and 'description:' frontmatter; MEMORY.md regenerates automatically — the description becomes the index line. Refuses to replace an existing file unless overwrite is true; to change an existing memory, edit it with str_replace/insert instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the memory root" },
        file_text: { type: "string", description: "Full file contents" },
        overwrite: { type: "boolean", description: "Set true to deliberately replace an existing file (default false)" },
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
      "Delete a file or directory in the memory folder. The MEMORY.md index updates automatically.",
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

    case "search": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new ToolError("query is required");
      const terms = [...new Set(query.toLowerCase().split(/\s+/))];
      let root = MEMORY_DIR;
      if (args.space) {
        root = resolve(MEMORY_DIR, String(args.space));
        if (!under(root, MEMORY_DIR)) throw new ToolError(`space escapes the memory directory: ${args.space}`);
        if (!existsSync(root)) throw new ToolError(`no such space: ${args.space}`);
      }
      const files = [];
      await collectMarkdown(root, files);
      const hits = [];
      for (const abs of files) {
        const text = await readFile(abs, "utf8").catch(() => null);
        if (text === null) continue;
        const hit = scoreMemory(relative(MEMORY_DIR, abs), basename(abs), text, terms);
        if (hit) hits.push(hit);
      }
      const where = args.space ? `in ${relative(MEMORY_DIR, root)}/` : "vault-wide";
      return { text: renderSearch(hits, query, where), structuredContent: searchResultsPayload(hits) };
    }

    case "fetch": {
      const id = String(args.id ?? "").trim();
      if (!id) throw new ToolError("id is required");
      const abs = resolvePath(id, scope);
      const st = await stat(abs).catch(() => null);
      if (!st || st.isDirectory()) throw new ToolError(`not found: ${id}`);
      const payload = fetchPayload(relative(MEMORY_DIR, abs), await readFile(abs, "utf8"));
      return { text: JSON.stringify(payload), structuredContent: payload };
    }

    case "create": {
      const abs = resolvePath(args.path, scope);
      if (isIndex(abs)) throw new ToolError(INDEX_EDIT_ERROR);
      if (typeof args.file_text !== "string") throw new ToolError("file_text is required");
      if (args.overwrite !== true && existsSync(abs)) {
        throw new ToolError(
          `${rel(abs, scope)} already exists — edit it with str_replace/insert, or pass overwrite: true to replace it deliberately`,
        );
      }
      await mkdir(dirname(abs), { recursive: true });
      await atomicWrite(abs, stampId(args.file_text));
      await reindexFor(abs);
      return `Created ${rel(abs, scope)}`;
    }

    case "str_replace": {
      const abs = resolvePath(args.path, scope);
      if (isIndex(abs)) throw new ToolError(INDEX_EDIT_ERROR);
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
      await reindexFor(abs);
      return `Edited ${rel(abs, scope)}`;
    }

    case "insert": {
      const abs = resolvePath(args.path, scope);
      if (isIndex(abs)) throw new ToolError(INDEX_EDIT_ERROR);
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
      await reindexFor(abs);
      return `Inserted into ${rel(abs, scope)} after line ${at}`;
    }

    case "delete": {
      const abs = resolvePath(args.path, scope);
      if (abs === MEMORY_DIR || dirname(abs) === MEMORY_DIR) {
        throw new ToolError("refusing to delete the memory root or a space root");
      }
      if (isIndex(abs)) throw new ToolError(INDEX_EDIT_ERROR);
      const st = await stat(abs).catch(() => null);
      if (!st) throw new ToolError(`not found: ${args.path}`);
      await rm(abs, { recursive: true });
      await reindexFor(abs);
      return `Deleted ${rel(abs, scope)}`;
    }

    case "rename": {
      const from = resolvePath(args.old_path, scope);
      const to = resolvePath(args.new_path, scope);
      if (isIndex(from) || isIndex(to)) throw new ToolError(INDEX_EDIT_ERROR);
      if (!(await stat(from).catch(() => null))) throw new ToolError(`not found: ${args.old_path}`);
      await mkdir(dirname(to), { recursive: true });
      await fsRename(from, to);
      await reindexFor(from, to);
      return `Renamed ${rel(from, scope)} → ${rel(to, scope)}`;
    }

    default:
      throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
  }
}
