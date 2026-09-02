// GitHub-backed memory store: the same seven tools as src/store.mjs, but the
// store is the user's own private repo. One recursive tree fetch per request;
// every mutation lands as ONE commit (memory file + regenerated MEMORY.md)
// via blobs → tree → commit → compare-and-swap ref update, retried from
// scratch on concurrent movement. No module-level mutable state — everything
// hangs off the per-request store object (warm Lambda containers are shared).

import {
  ToolError,
  JsonRpcError,
  fetchPayload,
  indexContent,
  indexRow,
  renderSearch,
  scoreMemory,
  searchResultsPayload,
  stampId,
} from "../store.mjs";
import { ghApi, mintInstallationToken } from "./github-auth.mjs";
import { scanForSecrets } from "./scan.mjs";

const INDEX_FILE = "MEMORY.md";

// ── Opening the store (per request) ──────────────────────────────────────────

export async function openRepoStore(user) {
  const { token } = await mintInstallationToken(user.installation_id);
  const [owner, repoName] = user.repo_full_name.split("/");
  const repo = await ghApi(`/repos/${owner}/${repoName}`, { token });
  if (!repo.ok) throw new ToolError(`cannot reach your memories repository (${repo.status}) — was it deleted or the App uninstalled?`);
  // Guardrails: the repo behind the installation must still be the recorded
  // one, and must still be private (git history is permanent — never write
  // memories anywhere public).
  if (String(repo.json.id) !== String(user.repo_id)) {
    throw new ToolError("the repository behind your installation changed — reconnect the vault");
  }
  if (repo.json.private !== true) {
    throw new ToolError(
      `your memories repository ${user.repo_full_name} is PUBLIC — refusing all vault access until it is private again`,
    );
  }
  const branch = repo.json.default_branch;
  const store = {
    token,
    owner,
    repo: repoName,
    fullName: user.repo_full_name,
    branch,
    scope: user.default_space || "shared",
    headSha: null,
    rootTreeSha: null,
    tree: new Map(), // path -> { sha, type: "blob"|"tree" }
    blobCache: new Map(),
  };
  const ref = await ghApi(`/repos/${owner}/${repoName}/git/ref/${encodeURIComponent(`heads/${branch}`)}`, { token });
  if (ref.status === 404 || ref.status === 409) return store; // empty repo: reads see nothing, writes refuse
  if (!ref.ok) throw new ToolError(`could not read the repository ref (${ref.status})`);
  store.headSha = ref.json.object.sha;
  const commit = await ghApi(`/repos/${owner}/${repoName}/git/commits/${store.headSha}`, { token });
  if (!commit.ok) throw new ToolError(`could not read the head commit (${commit.status})`);
  store.rootTreeSha = commit.json.tree.sha;
  const tree = await ghApi(`/repos/${owner}/${repoName}/git/trees/${store.rootTreeSha}?recursive=1`, { token });
  if (!tree.ok) throw new ToolError(`could not read the repository tree (${tree.status})`);
  if (tree.json.truncated) throw new ToolError("repository tree is too large to load — this vault exceeds supported size");
  for (const e of tree.json.tree) store.tree.set(e.path, { sha: e.sha, type: e.type });
  return store;
}

async function readBlob(store, path) {
  if (store.blobCache.has(path)) return store.blobCache.get(path);
  const entry = store.tree.get(path);
  if (!entry || entry.type !== "blob") return null;
  const res = await ghApi(`/repos/${store.owner}/${store.repo}/git/blobs/${entry.sha}`, { token: store.token });
  if (!res.ok) throw new ToolError(`could not read ${path} (${res.status})`);
  const text = Buffer.from(res.json.content, "base64").toString("utf8");
  store.blobCache.set(path, text);
  return text;
}

// ── Path model (mirrors src/store.mjs resolvePath semantics) ─────────────────

const hasFile = (store, p) => store.tree.get(p)?.type === "blob";
const hasDir = (store, p) => {
  if (p === "") return true;
  if (store.tree.get(p)?.type === "tree") return true;
  const prefix = `${p}/`;
  for (const k of store.tree.keys()) if (k.startsWith(prefix)) return true;
  return false;
};
const exists = (store, p) => hasFile(store, p) || hasDir(store, p);

function cleanPath(p) {
  if (typeof p !== "string" || !p.trim()) throw new ToolError("path is required");
  let cleaned = p.trim().replace(/^\/?(memories\/)?/, "");
  const segs = cleaned.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.some((s) => s === "..")) throw new ToolError(`path escapes the memory directory: ${p}`);
  return segs.join("/");
}

// Scope is a routing default, not a wall (within the repo): relative paths
// land in the grant's default space; a path whose first segment names another
// space addresses it directly. The repo boundary is the real wall.
function resolvePath(store, p) {
  const cleaned = cleanPath(p);
  const scope = store.scope;
  if (cleaned === "") return scope; // "." → space root
  const fromScope = `${scope}/${cleaned}`;
  const fromRoot = cleaned;
  const firstSegment = cleaned.split("/")[0];
  const namesSpace = firstSegment && hasDir(store, firstSegment) && !exists(store, fromScope);
  if (exists(store, fromScope)) return fromScope;
  if (exists(store, fromRoot) || namesSpace) return fromRoot;
  return fromScope;
}

function rel(store, path) {
  const prefix = `${store.scope}/`;
  if (path === store.scope) return ".";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// Citation URL for a memory: its page in the user's own (private) repo —
// real for the user, and non-empty so ChatGPT-family clients cite it.
const blobUrl = (store, path) =>
  `https://github.com/${store.fullName}/blob/${store.branch}/${path.split("/").map(encodeURIComponent).join("/")}`;

const isIndex = (path) => path.split("/").pop() === INDEX_FILE;
const INDEX_EDIT_ERROR =
  "MEMORY.md is generated from each memory file's frontmatter — it can't be edited directly. Edit the memory file's description: instead; the index regenerates automatically.";

const spaceOf = (path) => {
  const segs = path.split("/");
  return segs.length >= 2 && !segs[0].startsWith(".") ? segs[0] : null;
};

// ── Atomic commit (blobs → tree → commit → CAS ref update) ───────────────────

class CasConflict extends Error {}

async function commitChanges(store, changes, message) {
  if (!store.headSha) {
    throw new ToolError("your memories repository has no commits — reconnect the vault to reinitialize it");
  }
  // Regenerate MEMORY.md for every space a change touches, from the
  // post-change set of root-level .md files (same projection as the local
  // store — indexRow/indexContent are shared).
  const spaces = new Set();
  for (const p of changes.keys()) {
    const s = spaceOf(p);
    if (s) spaces.add(s);
  }
  for (const space of spaces) {
    const names = new Set();
    for (const k of store.tree.keys()) {
      const m = k.match(new RegExp(`^${space.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+\\.md)$`));
      if (m && m[1] !== INDEX_FILE && !m[1].startsWith(".")) names.add(m[1]);
    }
    for (const [p, content] of changes) {
      const m = p.match(/^([^/]+)\/([^/]+\.md)$/);
      if (!m || m[1] !== space || m[2] === INDEX_FILE || m[2].startsWith(".")) continue;
      if (content === null) names.delete(m[2]);
      else names.add(m[2]);
    }
    const rows = [];
    for (const name of names) {
      const p = `${space}/${name}`;
      const text = changes.has(p) && changes.get(p) !== null ? changes.get(p) : ((await readBlob(store, p)) ?? "");
      rows.push(indexRow(name, text));
    }
    changes.set(`${space}/${INDEX_FILE}`, indexContent(space, rows));
  }

  const treeEntries = [];
  for (const [path, content] of changes) {
    if (content === null) {
      treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    } else {
      const blob = await ghApi(`/repos/${store.owner}/${store.repo}/git/blobs`, {
        token: store.token,
        method: "POST",
        body: { content: Buffer.from(content).toString("base64"), encoding: "base64" },
      });
      if (!blob.ok) throw new ToolError(`could not write content (${blob.status})`);
      treeEntries.push({ path, mode: "100644", type: "blob", sha: blob.json.sha });
    }
  }
  const tree = await ghApi(`/repos/${store.owner}/${store.repo}/git/trees`, {
    token: store.token,
    method: "POST",
    body: { base_tree: store.rootTreeSha, tree: treeEntries },
  });
  if (!tree.ok) throw new ToolError(`could not build the new tree (${tree.status}: ${tree.text.slice(0, 120)})`);
  const commit = await ghApi(`/repos/${store.owner}/${store.repo}/git/commits`, {
    token: store.token,
    method: "POST",
    body: { message, tree: tree.json.sha, parents: [store.headSha] },
  });
  if (!commit.ok) throw new ToolError(`could not create the commit (${commit.status})`);
  const ref = await ghApi(`/repos/${store.owner}/${store.repo}/git/refs/${encodeURIComponent(`heads/${store.branch}`)}`, {
    token: store.token,
    method: "PATCH",
    body: { sha: commit.json.sha, force: false },
  });
  if (ref.status === 422 || ref.status === 409) throw new CasConflict(); // the ref moved under us
  if (!ref.ok) throw new ToolError(`could not update the branch (${ref.status})`);
}

// ── The tools over the repo ───────────────────────────────────────────────────

const guardWrite = (text) => {
  const problem = scanForSecrets(text);
  if (problem) throw new ToolError(problem);
};

async function runTool(store, name, args) {
  switch (name) {
    case "view": {
      const path = resolvePath(store, args.path);
      if (hasDir(store, path) && !hasFile(store, path)) {
        const prefix = path === "" ? "" : `${path}/`;
        const entries = new Set();
        for (const k of store.tree.keys()) {
          if (!k.startsWith(prefix)) continue;
          const restOfPath = k.slice(prefix.length);
          const first = restOfPath.split("/")[0];
          if (!first || first.startsWith(".")) continue;
          entries.add(restOfPath.includes("/") || store.tree.get(k)?.type === "tree" ? `${first}/` : first);
        }
        const lines = [...entries].sort();
        if (path === store.scope) {
          const others = new Set();
          for (const k of store.tree.keys()) {
            const first = k.split("/")[0];
            if (k.includes("/") && first !== store.scope && !first.startsWith(".")) others.add(`${first}/  (other space)`);
          }
          const own = lines.join("\n") || "(no memories in this space yet)";
          const rest = [...others].sort();
          return `Directory: . (space "${store.scope}")\n${own}${rest.length ? `\n${rest.join("\n")}` : ""}`;
        }
        return `Directory: ${rel(store, path)}\n${lines.join("\n") || "(empty)"}`;
      }
      if (path === store.scope && !hasFile(store, path)) {
        // Empty space (git has no empty dirs) — mirror the local empty-listing.
        return `Directory: . (space "${store.scope}")\n(no memories in this space yet)`;
      }
      const text = await readBlob(store, path);
      if (text === null) throw new ToolError(`not found: ${args.path}`);
      const lines = text.split("\n");
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
      let prefix = "";
      if (args.space) {
        const space = cleanPath(String(args.space));
        if (!hasDir(store, space)) throw new ToolError(`no such space: ${args.space}`);
        prefix = `${space}/`;
      }
      const candidates = [];
      for (const [k, v] of store.tree) {
        if (v.type !== "blob" || !k.startsWith(prefix) || !k.endsWith(".md")) continue;
        const segs = k.split("/");
        if (segs.some((s) => s.startsWith(".")) || segs[segs.length - 1] === INDEX_FILE) continue;
        candidates.push(k);
      }
      const hits = [];
      // Bounded concurrency: the tree is already local, only blobs are fetched.
      const CONCURRENCY = 10;
      for (let i = 0; i < candidates.length; i += CONCURRENCY) {
        const batch = await Promise.all(
          candidates.slice(i, i + CONCURRENCY).map(async (path) => {
            const text = await readBlob(store, path).catch(() => null);
            if (text === null) return null;
            return scoreMemory(path, path.split("/").pop(), text, terms);
          }),
        );
        for (const hit of batch) if (hit) hits.push(hit);
      }
      const where = args.space ? `in ${prefix}` : "vault-wide";
      return {
        text: renderSearch(hits, query, where),
        structuredContent: searchResultsPayload(hits, (p) => blobUrl(store, p)),
      };
    }

    case "fetch": {
      const id = String(args.id ?? "").trim();
      if (!id) throw new ToolError("id is required");
      const path = resolvePath(store, id);
      const text = await readBlob(store, path);
      if (text === null) throw new ToolError(`not found: ${id}`);
      const payload = fetchPayload(path, text, blobUrl(store, path));
      return { text: JSON.stringify(payload), structuredContent: payload };
    }

    case "create": {
      const path = resolvePath(store, args.path);
      if (isIndex(path)) throw new ToolError(INDEX_EDIT_ERROR);
      if (typeof args.file_text !== "string") throw new ToolError("file_text is required");
      if (args.overwrite !== true && hasFile(store, path)) {
        throw new ToolError(
          `${rel(store, path)} already exists — edit it with str_replace/insert, or pass overwrite: true to replace it deliberately`,
        );
      }
      guardWrite(args.file_text);
      await commitChanges(store, new Map([[path, stampId(args.file_text)]]), `vault: create ${path}`);
      return `Created ${rel(store, path)}`;
    }

    case "str_replace": {
      const path = resolvePath(store, args.path);
      if (isIndex(path)) throw new ToolError(INDEX_EDIT_ERROR);
      const text = await readBlob(store, path);
      if (text === null) throw new ToolError(`not found: ${args.path}`);
      const { old_str: oldStr, new_str: newStr } = args;
      if (typeof oldStr !== "string" || typeof newStr !== "string") {
        throw new ToolError("old_str and new_str are required");
      }
      const count = text.split(oldStr).length - 1;
      if (count === 0) throw new ToolError("old_str not found in file");
      if (count > 1) throw new ToolError(`old_str occurs ${count} times — must be unique`);
      guardWrite(newStr);
      await commitChanges(store, new Map([[path, text.replace(oldStr, newStr)]]), `vault: edit ${path}`);
      return `Edited ${rel(store, path)}`;
    }

    case "insert": {
      const path = resolvePath(store, args.path);
      if (isIndex(path)) throw new ToolError(INDEX_EDIT_ERROR);
      const text = await readBlob(store, path);
      if (text === null) throw new ToolError(`not found: ${args.path}`);
      const lines = text.split("\n");
      const at = Number(args.insert_line);
      if (!Number.isInteger(at) || at < 0 || at > lines.length) {
        throw new ToolError(`insert_line must be between 0 and ${lines.length}`);
      }
      guardWrite(String(args.insert_text ?? ""));
      lines.splice(at, 0, String(args.insert_text ?? ""));
      await commitChanges(store, new Map([[path, lines.join("\n")]]), `vault: edit ${path}`);
      return `Inserted into ${rel(store, path)} after line ${at}`;
    }

    case "delete": {
      const path = resolvePath(store, args.path);
      if (path === "" || !path.includes("/")) {
        throw new ToolError("refusing to delete the memory root or a space root");
      }
      if (isIndex(path)) throw new ToolError(INDEX_EDIT_ERROR);
      const changes = new Map();
      if (hasFile(store, path)) {
        changes.set(path, null);
      } else if (hasDir(store, path)) {
        for (const [k, v] of store.tree) {
          if (v.type === "blob" && k.startsWith(`${path}/`)) changes.set(k, null);
        }
      } else {
        throw new ToolError(`not found: ${args.path}`);
      }
      await commitChanges(store, changes, `vault: delete ${path}`);
      return `Deleted ${rel(store, path)}`;
    }

    case "rename": {
      const from = resolvePath(store, args.old_path);
      const to = resolvePath(store, args.new_path);
      if (isIndex(from) || isIndex(to)) throw new ToolError(INDEX_EDIT_ERROR);
      const changes = new Map();
      if (hasFile(store, from)) {
        changes.set(to, await readBlob(store, from));
        changes.set(from, null);
      } else if (hasDir(store, from)) {
        for (const [k, v] of store.tree) {
          if (v.type !== "blob" || !k.startsWith(`${from}/`)) continue;
          changes.set(`${to}/${k.slice(from.length + 1)}`, await readBlob(store, k));
          changes.set(k, null);
        }
      } else {
        throw new ToolError(`not found: ${args.old_path}`);
      }
      await commitChanges(store, changes, `vault: rename ${from} → ${to}`);
      return `Renamed ${rel(store, from)} → ${rel(store, to)}`;
    }

    default:
      throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
  }
}

const MUTATING = new Set(["create", "str_replace", "insert", "delete", "rename"]);

// The per-user callTool: opens fresh repo state and, for mutations, retries
// the WHOLE operation on a compare-and-swap conflict — preconditions are
// re-checked against the new head each attempt.
export function makeCallTool(user) {
  return async function hostedCallTool(name, args) {
    const attempts = MUTATING.has(name) ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      const store = await openRepoStore(user);
      try {
        return await runTool(store, name, args);
      } catch (err) {
        if (err instanceof CasConflict && attempt < attempts) {
          await new Promise((r) => setTimeout(r, 100 + Math.random() * 300));
          continue;
        }
        if (err instanceof CasConflict) {
          throw new ToolError("the vault changed concurrently and retries were exhausted — please retry");
        }
        throw err;
      }
    }
  };
}
