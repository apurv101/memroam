// Claude Code driver — extraction of run.mjs's original runClaude, behavior-identical.
//
//   claude -p --output-format json --model M --tools "" --no-session-persistence \
//          --mcp-config <workDir>/mcp-<label>.json --strict-mcp-config \
//          [--allowedTools ...] [--bare]
//
// Contamination: subscription mode (no --bare) auto-loads ~/.claude/CLAUDE.md
// into the agent; --bare is the clean room but requires ANTHROPIC_API_KEY.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnCapture } from "./index.mjs";

export async function run({ prompt, mcpUrl, allowedTools, model, bare, workDir, timeoutMs, label, baseUrl, apiKeyEnv, env }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--tools", "",              // no built-in tools; MCP tools only
    "--no-session-persistence",
  ];
  if (bare) args.push("--bare");
  const mcpFile = join(workDir, `mcp-${label.replace(/[^a-z0-9-]/gi, "_")}.json`);
  const mcpServers = mcpUrl ? { vault: { type: "http", url: mcpUrl } } : {};
  await writeFile(mcpFile, JSON.stringify({ mcpServers }));
  args.push("--mcp-config", mcpFile, "--strict-mcp-config");
  if (allowedTools?.length) args.push("--allowedTools", allowedTools.join(","));

  // Backend routing: an explicit `env` (e.g. the judge's scrubbed env) wins;
  // otherwise a custom baseUrl builds a child env that routes this one call —
  // AUTH_TOKEN from the named env var, API_KEY blanked so it can't shadow it.
  let childEnv = env;
  if (!childEnv && baseUrl) {
    childEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: process.env[apiKeyEnv ?? ""] ?? "",
      ANTHROPIC_API_KEY: "",
      // Third-party backends cap output well below Claude Code's 32K default
      // (DashScope qwen3-30b-a3b 400s on it). Overridable via the env.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? "8192",
    };
  }

  const started = Date.now();
  const { stdout, stderr, code } = await spawnCapture({
    cmd: "claude", args, stdin: prompt, cwd: workDir, timeoutMs, label, env: childEnv,
  });
  if (code !== 0 && !stdout.trim())
    throw new Error(`${label}: exit ${code}: ${stderr.slice(0, 500)}`);

  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw new Error(`${label}: unparseable claude output: ${stdout.slice(0, 300)}`); }
  return {
    text: parsed.result ?? "",
    isError: Boolean(parsed.is_error),
    numTurns: parsed.num_turns,
    costUsd: parsed.total_cost_usd,
    usage: parsed.usage,
    models: Object.keys(parsed.modelUsage ?? {}), // resolved model IDs, not aliases
    durationMs: Date.now() - started,
  };
}
