// Lambda entry: one Function URL serving the platform pages, the OAuth
// authorization server, and the MCP endpoint. Stateless — every request
// authenticates from scratch; the only warm-container cache is the immutable
// GitHub App secret.

import { makeDispatch } from "../dispatch.mjs";
import { instructionsFor } from "../instructions.mjs";
import { JsonRpcError } from "../store.mjs";
import { makeCallTool } from "./ghstore.mjs";
import {
  approve,
  authenticateBearer,
  authorizationServerMetadata,
  authorize,
  githubCallback,
  installCallback,
  protectedResourceMetadata,
  register,
  token,
} from "./oauth.mjs";
import { landingPage } from "./pages.mjs";

const respond = ({ status, headers = {}, body = "" }) => ({ statusCode: status, headers, body });
const text = (status, body, headers = {}) =>
  respond({ status, headers: { "content-type": "text/plain; charset=utf-8", ...headers }, body });

const rpcJson = (id, payload) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...payload });
const rpc = (id, payload) =>
  respond({ status: 200, headers: { "content-type": "application/json" }, body: rpcJson(id, payload) });

function unauthorized(base, hadToken) {
  const parts = [`resource_metadata="${base}/.well-known/oauth-protected-resource"`];
  if (hadToken) parts.unshift('error="invalid_token"');
  return respond({
    status: 401,
    headers: { "www-authenticate": `Bearer ${parts.join(", ")}`, "content-type": "application/json" },
    body: JSON.stringify({ error: "unauthorized" }),
  });
}

async function mcp(base, headers, rawBody) {
  const auth = await authenticateBearer(headers);
  if (auth.error) return unauthorized(base, Boolean(headers.authorization ?? headers.Authorization));
  const user = auth.user;

  let message;
  try {
    message = JSON.parse(rawBody);
  } catch {
    return rpc(null, { error: { code: -32700, message: "Parse error" } });
  }
  if (Array.isArray(message) || typeof message !== "object" || message === null) {
    return rpc(null, { error: { code: -32600, message: "Expected a single JSON-RPC message" } });
  }
  if (message.id === undefined || message.id === null) return respond({ status: 202 }); // notification

  const scope = user.default_space;
  const scopeNote =
    `Scope note: this hosted vault is stored in your GitHub repository ${user.repo_full_name}; ` +
    `this connection's default space is "${scope}" — relative paths read and write there, and every change ` +
    `is a commit in that repository. Other spaces in the same repository remain addressable by path.`;
  const dispatch = makeDispatch({
    callTool: (name, args) => makeCallTool(user)(name, args),
    instructions: instructionsFor,
  });
  try {
    const result = await dispatch(message.method, message.params, scope, scopeNote);
    return rpc(message.id, { result });
  } catch (err) {
    const code = err instanceof JsonRpcError ? err.code : -32603;
    return rpc(message.id, { error: { code, message: err.message } });
  }
}

const parseForm = (body) => Object.fromEntries(new URLSearchParams(body));

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = (event.rawPath ?? "/").replace(/\/+$/, "") || "/";
  const headers = event.headers ?? {};
  const base = `https://${headers.host ?? headers.Host ?? ""}`;
  const query = Object.fromEntries(new URLSearchParams(event.rawQueryString ?? ""));
  const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";

  try {
    if (path === "/" && method === "GET") {
      return respond({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: landingPage() });
    }
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return respond(protectedResourceMetadata(base));
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp") {
      return respond(authorizationServerMetadata(base));
    }
    if (path === "/register" && method === "POST") {
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return text(400, "invalid JSON");
      }
      return respond(await register(body));
    }
    if (path === "/authorize" && method === "GET") return respond(await authorize(base, query));
    if (path === "/callback/github" && method === "GET") return respond(await githubCallback(base, query));
    if (path === "/callback/install" && method === "GET") return respond(await installCallback(query));
    if (path === "/approve" && method === "POST") return respond(await approve(parseForm(rawBody)));
    if (path === "/token" && method === "POST") return respond(await token(parseForm(rawBody)));
    if (path === "/mcp") {
      if (method !== "POST") return text(405, "POST only", { allow: "POST" });
      return await mcp(base, headers, rawBody);
    }
    return text(404, "Not found");
  } catch (err) {
    console.error("unhandled", path, err);
    return text(500, "internal error");
  }
}
