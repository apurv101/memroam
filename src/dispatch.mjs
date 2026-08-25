// JSON-RPC / MCP method dispatch, shared by every transport (local HTTP,
// stdio, and the hosted Lambda). The store behind tools/call is injected so
// the same protocol layer runs over the filesystem engine locally and the
// GitHub-backed engine in the cloud.

import { JsonRpcError, TOOLS } from "./store.mjs";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "memory-vault", version: "0.3.1" };

export function makeDispatch({ callTool, instructions, serverInfo = SERVER_INFO, tools = TOOLS }) {
  return async function dispatch(method, params, scope, scopeNote) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
            ? params.protocolVersion
            : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo,
          instructions: scopeNote ? `${instructions(scope)}\n\n${scopeNote}` : instructions(scope),
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools };
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
  };
}
