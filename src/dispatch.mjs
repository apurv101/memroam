// JSON-RPC / MCP method dispatch, shared by every transport (local HTTP,
// stdio, and the hosted Lambda). The store behind tools/call is injected so
// the same protocol layer runs over the filesystem engine locally and the
// GitHub-backed engine in the cloud.

import { JsonRpcError, TOOLS } from "./store.mjs";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// icons/websiteUrl are the 2025-11-25 spec's serverInfo fields; older clients
// ignore them. The URLs are served by the hosted tier and resolve for local
// (stdio) sessions too — the logo lives at the public domain either way.
export const SERVER_INFO = {
  name: "memory-vault",
  title: "Memory Vault",
  version: "0.5.0",
  websiteUrl: "https://memoryvault.click",
  icons: [
    { src: "https://memoryvault.click/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "https://memoryvault.click/icon.png", mimeType: "image/png", sizes: ["256x256"] },
  ],
};

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
          // Tools return a plain string, or {text, structuredContent} — the
          // structured form exists for OpenAI-connector search/fetch, whose
          // clients read structuredContent (MCP 2025-06-18).
          const out = await callTool(params.name, params.arguments ?? {}, scope);
          const { text, structuredContent } = typeof out === "string" ? { text: out } : out;
          return {
            content: [{ type: "text", text }],
            ...(structuredContent !== undefined ? { structuredContent } : {}),
            isError: false,
          };
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
