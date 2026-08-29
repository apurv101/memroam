// The two MCP transports over the same engine: stateless Streamable HTTP
// (legacy, POST one JSON-RPC message per request) and stdio (what the global
// registrations run — newline-delimited JSON-RPC, one scope per process).

import { createServer } from "node:http";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { JsonRpcError, MEMORY_DIR, PORT, TOOLS, callTool, setMemoryDir } from "./store.mjs";
import { instructionsFor } from "./instructions.mjs";
import { projectSlug, readRegistry, resolveSpace } from "./registry.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "memory-vault", version: "0.3.1" };

// ── JSON-RPC / MCP dispatch ───────────────────────────────────────────────────

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
    // We serve no resources or prompts, but answer the standard listings with
    // empty sets instead of -32601: some clients surface "Method not found" to
    // the model as an error, and smaller models then abandon the whole server.
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
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

export const server = createServer(async (req, res) => {
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

// ── stdio transport ───────────────────────────────────────────────────────────
//
// MCP over stdin/stdout, newline-delimited JSON-RPC, one scope per process.
// The scope is resolved the same way for every harness — no harness-specific
// code paths: an explicit MEMORY_SPACE env wins, else the client's MCP
// workspace roots (queried when the client declares the capability), else the
// process cwd. Roots matter because some harnesses spawn MCP servers at / —
// the cwd carries no signal there, but the protocol still names the
// workspace. Nothing but protocol may touch stdout here.

export async function stdioServe() {
  const registry = await readRegistry();
  setMemoryDir(process.env.MEMORY_DIR ?? registry.store ?? join(homedir(), ".memory-vault"));
  await mkdir(MEMORY_DIR, { recursive: true });
  const cwd = process.cwd();

  // MEMORY_SPACE pins the space explicitly. "shared" is refused like in
  // auto-detection — it is the org-wide directory, not a project space.
  const envSpace = projectSlug(process.env.MEMORY_SPACE ?? "");
  const pinned = envSpace !== "" && envSpace !== "shared";
  let scope = pinned ? envSpace : await resolveSpace(cwd);
  let scopeNote;
  if (pinned) {
    scopeNote = `Scope note: space "${scope}" was set explicitly (MEMORY_SPACE); other spaces remain addressable by path.`;
  } else if (scope === "default") {
    // Sessions in a non-project directory land in the fallback space. Explain
    // that in the handshake instructions — the session can then tell its user
    // which folder to open instead of reporting the vault as unreadable.
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

  const log = process.env.MEMORY_VAULT_LOG
    ? (dir, text) => appendFile(process.env.MEMORY_VAULT_LOG, `${new Date().toISOString()} ${dir} ${text}\n`).catch(() => {})
    : () => {};
  const send = (payload) => {
    const line = JSON.stringify({ jsonrpc: "2.0", ...payload });
    log("out", line);
    process.stdout.write(line + "\n");
  };
  const respond = (id, payload) => send({ id: id ?? null, ...payload });

  // Roots re-scope: sent after the client's initialized notification (the
  // protocol forbids server requests before it), so the initialize response's
  // instructions may briefly describe the cwd-derived scope — tool calls use
  // whatever the scope is at call time, and MEMORY.md always shows the truth.
  let clientSupportsRoots = false;
  const ROOTS_ID = "memory-vault:roots";
  const requestRoots = () => {
    if (clientSupportsRoots && !pinned) send({ id: ROOTS_ID, method: "roots/list" });
  };
  const applyRoots = async (roots) => {
    if (pinned || !Array.isArray(roots) || roots.length === 0) return;
    let rootPath;
    try {
      rootPath = fileURLToPath(roots[0].uri);
    } catch {
      return;
    }
    const rootScope = await resolveSpace(rootPath);
    if (rootScope !== "default" && rootScope !== scope) {
      scope = rootScope;
      scopeNote = `Scope note: space "${scope}" was derived from the client's workspace root (${rootPath}); other spaces remain addressable by path.`;
    }
  };

  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      log("in", line);
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
      if (message.method === undefined) {
        // A response to one of our requests — never dispatched, never answered.
        if (message.id === ROOTS_ID && message.result) await applyRoots(message.result.roots);
        continue;
      }
      if (message.id === undefined || message.id === null) {
        if (message.method === "notifications/initialized") requestRoots();
        else if (message.method === "notifications/roots/list_changed") requestRoots();
        continue; // other notifications need no reply
      }
      if (message.method === "initialize") {
        clientSupportsRoots = Boolean(message.params?.capabilities?.roots);
      }
      try {
        const result = await dispatch(message.method, message.params, scope, scopeNote);
        respond(message.id, { result });
      } catch (err) {
        respond(message.id, { error: { code: err instanceof JsonRpcError ? err.code : -32603, message: err.message } });
      }
    }
  }
}
