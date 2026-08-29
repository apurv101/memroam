// Per-harness drivers for the eval harness — one file per CLI, zero deps.
//
// Contract (every driver exports `run`):
//
//   async run({ prompt, mcpUrl, allowedTools, model, bare, workDir, timeoutMs, label,
//               baseUrl?, apiKeyEnv?, wireApi?, env? })
//     -> { text, isError, numTurns, costUsd, usage, models, durationMs, raw? }
//
//   baseUrl/apiKeyEnv route the call to a custom backend (claude: child env
//   ANTHROPIC_BASE_URL + AUTH_TOKEN from the named env var; codex: -c
//   model_providers overrides, wireApi = "responses"|"chat"). `env` overrides
//   the child environment outright (used by the judge's scrubbed env) and
//   takes precedence over baseUrl.
//
//   prompt       goes to the agent via stdin (avoids arg-length/quoting issues)
//   mcpUrl       HTTP MCP endpoint for the vault server, or null for no MCP
//   allowedTools per-tool allowlist — only Claude Code supports this; other
//                drivers ignore it (read-only-ness is enforced server-side)
//   model        model id/alias passed through to the CLI; null = CLI default
//   bare         clean-room mode where the CLI supports it (claude --bare)
//   workDir      sterile temp cwd — no project config, no repo
//   usage        normalized to the Anthropic shape: { input_tokens,
//                cache_creation_input_tokens, cache_read_input_tokens,
//                output_tokens, output_tokens_details: { thinking_tokens } }
//   costUsd      null when the CLI doesn't price (codex) — reprice from usage
//   models       resolved model ids when the CLI reports them, else [requested]
//
// The judge always runs on the claude driver regardless of the QA harness:
// the judge is the measurement instrument and must stay constant across cells.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";

export const drivers = { claude, codex };

// ── Backend config (evals/.env) ───────────────────────────────────────────────
//
// evals/.env (gitignored; template in evals/.env.example) holds endpoints and
// keys for every provider. Real environment variables always win over the file.
export function loadDotEnv(file = join(dirname(fileURLToPath(import.meta.url)), "..", ".env")) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
  return true;
}

// Provider profiles by naming convention, so `--provider dashscope` needs no
// further flags once evals/.env is filled in:
//   <PROVIDER>_ANTHROPIC_BASE_URL  → used when harness speaks Anthropic (claude)
//   <PROVIDER>_OPENAI_BASE_URL     → used when harness speaks OpenAI (codex)
//   <PROVIDER>_API_KEY             → the key itself (its NAME becomes apiKeyEnv)
// Explicit --base-url / --api-key-env flags override the convention.
const WIRE_FAMILY = { claude: "ANTHROPIC", codex: "OPENAI" };

export function resolveBackend({ provider, harness, baseUrl, apiKeyEnv }) {
  if (provider === "native") return { baseUrl: null, apiKeyEnv: null };
  const P = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const family = WIRE_FAMILY[harness] ?? "OPENAI";
  const resolved = {
    baseUrl: baseUrl ?? process.env[`${P}_${family}_BASE_URL`] ?? null,
    apiKeyEnv: apiKeyEnv ?? (process.env[`${P}_API_KEY`] != null ? `${P}_API_KEY` : null),
  };
  if (!resolved.baseUrl)
    throw new Error(`provider "${provider}": no --base-url and ${P}_${family}_BASE_URL is not set (evals/.env)`);
  return resolved;
}

// Shared spawn helper: capture stdout/stderr, write prompt to stdin, SIGKILL
// on timeout. Resolves { stdout, stderr, code }; rejects on timeout or spawn
// failure. Callers decide what a nonzero exit means.
export function spawnCapture({ cmd, args, stdin, cwd, env, timeoutMs, label }) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, args, { cwd, env: env ?? process.env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${label}: timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
    proc.stdin.on("error", () => {}); // EPIPE if the CLI exits before reading
    proc.stdin.write(stdin ?? "");
    proc.stdin.end();
  });
}
