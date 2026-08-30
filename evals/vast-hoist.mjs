#!/usr/bin/env node
// System-message hoist middleware for the vast shim path. Zero deps.
//
// Non-bare Claude Code sends its system prompt as multiple blocks; LiteLLM's
// anthropic→chat translation emits them as multiple system messages, and
// vLLM's qwen chat template 400s on any system message that isn't first
// ("System message must be at the beginning"). This proxy sits between the
// LiteLLM shim and the pod and merges all system messages into one at index 0.
// A request with zero or one leading system message passes through unchanged,
// so the codex /responses→chat route is unaffected.
//
//   node evals/vast-hoist.mjs   # listens on :4043
//   upstream = VAST_UPSTREAM_OPENAI_BASE_URL (the pod's /v1), from env or
//              evals/.vast.env; the shim then points at http://127.0.0.1:4043
//
// Streaming responses are piped through untouched.

import { createServer } from "node:http";
import { loadDotEnv } from "./lib.mjs";

loadDotEnv();
const PORT = Number(process.env.HOIST_PORT ?? 4043);
// Strip the /v1 suffix: LiteLLM is pointed at http://127.0.0.1:4043/v1, so
// incoming paths already carry /v1/… and we join them onto the pod's origin.
const upstreamBase = (process.env.VAST_UPSTREAM_OPENAI_BASE_URL ?? "").replace(/\/$/, "").replace(/\/v1$/, "");
if (!upstreamBase) { console.error("VAST_UPSTREAM_OPENAI_BASE_URL not set (evals/.vast.env — is the pod up?)"); process.exit(1); }

function hoistSystems(body) {
  try {
    const req = JSON.parse(body);
    if (!Array.isArray(req.messages)) return body;
    const systems = req.messages.filter((m) => m.role === "system");
    if (systems.length === 0 || (systems.length === 1 && req.messages[0].role === "system")) return body;
    const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("\n") : String(c ?? ""));
    const merged = { role: "system", content: systems.map((m) => text(m.content)).join("\n\n") };
    req.messages = [merged, ...req.messages.filter((m) => m.role !== "system")];
    return JSON.stringify(req);
  } catch { return body; }
}

createServer((cin, cout) => {
  const chunks = [];
  cin.on("data", (d) => chunks.push(d));
  cin.on("end", async () => {
    let body = Buffer.concat(chunks).toString("utf8");
    if (cin.method === "POST" && /\/chat\/completions/.test(cin.url ?? "")) body = hoistSystems(body);
    try {
      const headers = { ...cin.headers };
      delete headers.host; delete headers["content-length"]; delete headers.connection;
      const r = await fetch(upstreamBase + cin.url, {
        method: cin.method,
        headers,
        body: ["GET", "HEAD"].includes(cin.method) ? undefined : body,
      });
      cout.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !["content-length", "transfer-encoding", "connection", "content-encoding"].includes(k))));
      if (r.body) for await (const chunk of r.body) cout.write(chunk); // stream through (SSE-safe)
      cout.end();
    } catch (e) {
      cout.writeHead(502, { "content-type": "application/json" });
      cout.end(JSON.stringify({ error: { message: `hoist proxy: upstream failed: ${e.message}` } }));
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`hoist proxy on :${PORT} → ${upstreamBase}`));
