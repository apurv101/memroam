// The two MCP transports over the same engine: stateless Streamable HTTP
// (legacy, POST one JSON-RPC message per request) and stdio (what the global
// registrations run — newline-delimited JSON-RPC, one scope per process).

import { createServer } from "node:http";
import { mkdir, readdir } from "node:fs/promises";
import { JsonRpcError, MEMORY_DIR, PORT, TOOLS, callTool, setMemoryDir } from "./store.mjs";
import { instructionsFor } from "./instructions.mjs";
import { readRegistry, resolveSpace } from "./registry.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

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
// MCP over stdin/stdout, newline-delimited JSON-RPC, one scope for the whole
// process: the harness spawns us in the session's directory, and that cwd
// names the project space. Nothing but protocol may touch stdout here.

export async function stdioServe() {
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
