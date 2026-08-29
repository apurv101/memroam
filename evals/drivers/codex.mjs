// Codex CLI driver (verified against codex-cli 0.149.1, live probes 2026-08-28).
//
//   codex exec --ignore-user-config --ephemeral --skip-git-repo-check --color never \
//        -C <workDir> -s read-only --json -o <workDir>/last-<label>.txt \
//        [-m M] -c 'mcp_servers.vault.url="<mcpUrl>"' <approval override> -
//
// JSONL events on stdout: thread.started / turn.started / item.started /
// item.completed (item.type: agent_message | mcp_tool_call | ...) /
// turn.completed { usage } / turn.failed.
//
// Notes:
//  - `allowedTools` is ignored: codex has no per-MCP-tool allowlist. Read-only
//    QA enforcement is server-side (RO endpoint on the vault server — follow-up).
//  - costUsd is always null: codex reports tokens, never dollars. Reprice offline
//    from `usage` (raw codex counters preserved under `raw.usage`).
//  - Resolved model appears only in the non-JSON banner, not in JSON events, so
//    `models` echoes the requested model. Matrix runs should always pass -m;
//    smoke.mjs resolves the CLI default for provenance.
//  - MCP tool calls require an approval override or they fail with "MCP tool
//    call requires approval, but approval policy is never". The working config
//    key is pinned empirically by smoke.mjs into codex-approval.json; until a
//    pin exists we use the first candidate. If the pin is the dangerous bypass,
//    record it in provenance (run.mjs does this).
//
// Contamination: --ignore-user-config is a real clean room (auth still loads
// from CODEX_HOME). Cleanest of the harnesses.

import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCapture } from "./index.mjs";

const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), "codex-approval.json");

// Candidate -c overrides that may exempt vault MCP calls from approval, best
// guess first (surfaced by binary-string inspection). smoke.mjs probes these in
// order and pins the winner.
export const APPROVAL_CANDIDATES = [
  // Documented at learn.chatgpt.com/docs/extend/mcp: per-server
  // default_tools_approval_mode ∈ {"approve","prompt","writes",...} — "approve"
  // auto-approves every tool on the server.
  { name: "per-server default_tools_approval_mode=approve",
    args: ["-c", 'mcp_servers.vault.default_tools_approval_mode="approve"'] },
  { name: "per-server default_tools_approval_mode=auto",
    args: ["-c", 'mcp_servers.vault.default_tools_approval_mode="auto"'] },
  { name: "approve-for-me (auto-review; incompatible with -s, so sandbox flag is dropped)",
    args: ["--approve-for-me"], dropSandboxFlag: true },
  { name: "DANGEROUS: bypass approvals and sandbox",
    args: ["--dangerously-bypass-approvals-and-sandbox"], dangerous: true },
];

export async function approvalPin() {
  if (!existsSync(PIN_FILE)) return null;
  try { return JSON.parse(await readFile(PIN_FILE, "utf8")); } catch { return null; }
}

export async function run({ prompt, mcpUrl, allowedTools, model, bare, workDir, timeoutMs, label, approval, baseUrl, apiKeyEnv, wireApi }) {
  void allowedTools; void bare; // unsupported by codex — see header notes
  // Per-call private cwd. Codex keeps its shell tool even in the read-only
  // sandbox, and the sandbox permits reads of the whole disk — a shared cwd
  // leaks sibling calls' -o output files (e.g. closed_book reading the
  // full_context arm's answers). A private empty cwd removes everything an
  // exploring agent can find nearby; full-disk reads remain a residual risk
  // recorded in provenance.
  const callDir = join(workDir, `codex-${label.replace(/[^a-z0-9-]/gi, "_")}`);
  await mkdir(callDir, { recursive: true });
  const lastFile = join(callDir, "last.txt");
  const pinned = mcpUrl ? (approval ?? (await approvalPin()) ?? APPROVAL_CANDIDATES[0]) : null;
  const args = [
    "exec",
    "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
    "--color", "never",
    "-C", callDir,
    ...(pinned?.dropSandboxFlag || pinned?.dangerous ? [] : ["-s", "read-only"]),
    "--json",
    "-o", lastFile,
  ];
  if (model) args.push("-m", model);
  // Custom OpenAI-compatible backend (DashScope compatible-mode, vLLM, ...):
  // codex reads the key itself from the env var named by env_key — the secret
  // never appears in argv. wire_api is pinned by smoke (responses vs chat).
  if (baseUrl) {
    args.push(
      "-c", 'model_provider="custom"',
      "-c", 'model_providers.custom.name="custom"',
      "-c", `model_providers.custom.base_url="${baseUrl}"`,
      "-c", `model_providers.custom.env_key="${apiKeyEnv ?? ""}"`,
      "-c", `model_providers.custom.wire_api="${wireApi ?? "responses"}"`,
    );
  }
  if (mcpUrl) {
    args.push("-c", `mcp_servers.vault.url="${mcpUrl}"`);
    args.push(...pinned.args);
  }
  args.push("-");

  const started = Date.now();
  const { stdout, stderr, code } = await spawnCapture({
    cmd: "codex", args, stdin: prompt, cwd: callDir, timeoutMs, label,
  });
  if (code !== 0 && !stdout.trim())
    throw new Error(`${label}: exit ${code}: ${stderr.slice(0, 500)}`);

  // Parse the JSONL event stream.
  const events = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* non-event noise */ }
  }
  const items = events.filter((e) => e.type === "item.completed").map((e) => e.item);
  const lastMessage = items.filter((i) => i.type === "agent_message").at(-1)?.text;
  let text = lastMessage ?? "";
  if (!text && existsSync(lastFile)) {
    try { text = (await readFile(lastFile, "utf8")).trim(); } catch {}
  }

  // Sum usage across turn.completed events (normally exactly one per exec).
  const turns = events.filter((e) => e.type === "turn.completed" && e.usage);
  const sum = (k) => turns.reduce((a, t) => a + (t.usage[k] ?? 0), 0);
  const rawUsage = {
    input_tokens: sum("input_tokens"),                     // includes cached
    cached_input_tokens: sum("cached_input_tokens"),
    cache_write_input_tokens: sum("cache_write_input_tokens"),
    output_tokens: sum("output_tokens"),
    reasoning_output_tokens: sum("reasoning_output_tokens"),
  };
  const usage = {
    input_tokens: rawUsage.input_tokens - rawUsage.cached_input_tokens,
    cache_creation_input_tokens: rawUsage.cache_write_input_tokens,
    cache_read_input_tokens: rawUsage.cached_input_tokens,
    output_tokens: rawUsage.output_tokens,
    output_tokens_details: { thinking_tokens: rawUsage.reasoning_output_tokens },
  };

  const failed = events.some((e) => e.type === "turn.failed");
  const mcpErrors = items.filter((i) => i.type === "mcp_tool_call" && i.status === "failed");
  return {
    text,
    isError: failed || turns.length === 0,
    numTurns: items.length, // agent messages + tool calls within the single exec turn
    costUsd: null,          // codex doesn't price; reprice from usage
    usage,
    models: [model ?? "codex-default"],
    durationMs: Date.now() - started,
    raw: { usage: rawUsage, mcpFailedCalls: mcpErrors.length },
  };
}
