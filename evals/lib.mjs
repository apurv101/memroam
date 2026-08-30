// Shared library for the eval entry points (run.mjs, vast.mjs, drivers/smoke.mjs).
// One home for logic that every script needs, so no entry point grows its own
// copy: CLI arg parsing, env-file parsing, vault-server lifecycle, the vault
// tool lists, the versioned prompt templates, and the deterministic vault
// health check. Driver plumbing (the per-harness contract, resolveBackend,
// spawnCapture) stays in drivers/index.mjs. Zero deps.

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = resolve(EVALS_DIR, "..");
const SERVER = join(REPO_DIR, "server.mjs");

// ── CLI args ──────────────────────────────────────────────────────────────────

// `const { opt, flag } = cliArgs()` — the one arg parser every script uses.
export function cliArgs(argv = process.argv.slice(2)) {
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
  };
  const flag = (name) => argv.includes(`--${name}`);
  return { argv, opt, flag };
}

// Shared validation for the custom-backend flags (run.mjs and smoke.mjs take
// the same trio): a bare --base-url has no cell name, and a custom provider
// has no notion of the CLI's default model alias.
export function assertBackendFlags({ provider, baseUrl, model }) {
  if (baseUrl && provider === "native")
    throw new Error("--base-url requires --provider <tag> (a short label like dashscope/vast for cell naming)");
  if (provider !== "native" && !model)
    throw new Error(`--provider ${provider} requires an explicit --model (the backend won't have the CLI's default)`);
}

// ── Env files ─────────────────────────────────────────────────────────────────

// The one KEY=VALUE parser — used for evals/.env, evals/.vast.env, and any
// state file in the same format. Returns null if the file doesn't exist.
export function parseEnvFile(file) {
  if (!existsSync(file)) return null;
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// evals/.env (gitignored; template in evals/.env.example) holds endpoints and
// keys for every provider; evals/.vast.env is generated pod state from
// `node evals/vast.mjs start` and overlays it. Real env vars always win over both.
export function loadDotEnv(file) {
  const files = file ? [file] : [join(EVALS_DIR, ".env"), join(EVALS_DIR, ".vast.env")];
  let any = false;
  for (const f of files) {
    const vars = parseEnvFile(f);
    if (!vars) continue;
    any = true;
    for (const [k, v] of Object.entries(vars)) if (!(k in process.env)) process.env[k] = v;
  }
  return any;
}

// ── Vault server lifecycle ────────────────────────────────────────────────────

// Full tool surface the server exposes (src/store.mjs). The read-only subset
// matters: the server's own instructions advertise `search`, and a model that
// keeps calling a denied tool can spin until timeout (seen with qwen via
// DashScope; sonnet happened to stick to `view`).
export const VAULT_TOOLS = ["view", "search", "create", "str_replace", "insert", "delete", "rename"]
  .map((t) => `mcp__vault__${t}`);
export const VAULT_READ_TOOLS = ["mcp__vault__view", "mcp__vault__search"];

// Spawn server.mjs on a random port against a temp MEMORY_DIR; resolve once it
// answers on /mcp (any response, 405 included, means up).
export async function spawnVaultServer(memoryDir) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MEMORY_DIR: memoryDir, VAULT_PORT: String(port) },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/mcp`, { method: "GET" });
      return { port, base, kill: () => proc.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  proc.kill();
  throw new Error("vault server did not come up");
}

// Create a fresh memory scope with the empty index the server expects.
export async function seedScope(memoryDir, scope) {
  const dir = join(memoryDir, scope);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "MEMORY.md"), `# Memory index — ${scope}\n\n`);
  return dir;
}

// ── Prompts (versioned; bump PROMPTS_VERSION when any template changes) ───────
//
// These are the measurement instrument — every entry point (run.mjs cells,
// smoke gate, vast probe) must use the same templates so a probe exercises the
// exact prompt shape the cells will.

export const PROMPTS_VERSION = 2;

export const ingestPrompt = (session) =>
  `A session is ending. Below is its complete transcript, dated ${session.date}.
Persist to your memory directory whatever your memory instructions say is worth persisting from this session. Do not answer the transcript; just do the memory work, then reply "done".

--- TRANSCRIPT (${session.date}) ---
${session.transcript.join("\n")}
--- END TRANSCRIPT ---`;

export const qaVaultPrompt = (q, today) =>
  `Today is ${today}. Using only your memory directory, answer the user's question. If the answer is not in your memory, say plainly that you don't know. Answer in one or two sentences.

Question: ${q.question}`;

export const qaClosedBookPrompt = (q, today) =>
  `Today is ${today}. Answer the user's question about their project in one or two sentences. If you don't know, say plainly that you don't know.

Question: ${q.question}`;

export const qaFullContextPrompt = (q, today, conv) =>
  `Today is ${today}. Below are the complete transcripts of your past sessions with the user. Using them, answer the question in one or two sentences. If the transcripts don't contain the answer, say plainly that you don't know.

${conv.sessions.map((s) => `--- SESSION (${s.date}) ---\n${s.transcript.join("\n")}`).join("\n\n")}

Question: ${q.question}`;

export const judgePrompt = (q, answer) =>
  `You are grading a candidate answer against a gold answer. Be strict but fair: the candidate is correct if it states the same essential fact(s) as the gold answer; extra detail is fine, contradicting or missing the essential fact is not.

Special rule: if the gold answer is "NOT_IN_MEMORY", the candidate is correct only if it declines to answer / says it doesn't know. Any invented substantive answer is incorrect.

Question: ${q.question}
Gold answer: ${q.gold}
Candidate answer: ${answer}

Reply with ONLY this JSON, nothing else: {"verdict":"correct"|"incorrect","reason":"<one sentence>"}`;

// ── Vault health checks (deterministic, no judge) ─────────────────────────────

async function walkMd(dir, base = dir) {
  let files = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files = files.concat(await walkMd(p, base));
    else if (e.name.endsWith(".md")) files.push(p.slice(base.length + 1));
  }
  return files;
}

export async function healthCheck(scopeDir, questions) {
  const issues = [];
  const files = existsSync(scopeDir) ? await walkMd(scopeDir) : [];
  const memories = files.filter((f) => f !== "MEMORY.md");
  let indexLinks = [];
  if (!files.includes("MEMORY.md")) issues.push("no MEMORY.md index");
  else {
    const idx = await readFile(join(scopeDir, "MEMORY.md"), "utf8");
    indexLinks = [...idx.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
    for (const f of memories) if (!indexLinks.includes(f)) issues.push(`unindexed file: ${f}`);
    for (const l of indexLinks) if (!memories.includes(l)) issues.push(`dangling index line: ${l}`);
  }
  const names = new Map();
  const bodies = {};
  for (const f of memories) {
    const text = await readFile(join(scopeDir, f), "utf8");
    bodies[f] = text;
    if (!/^---\n[\s\S]*?\bname:/m.test(text)) issues.push(`missing name: frontmatter: ${f}`);
    if (!/\bdescription:/.test(text)) issues.push(`missing description: frontmatter: ${f}`);
    const name = text.match(/\bname:\s*(\S+)/)?.[1];
    if (name) {
      if (names.has(name)) issues.push(`duplicate name slug "${name}": ${names.get(name)} and ${f}`);
      names.set(name, f);
    }
  }
  // Stale-fact survival: a file that mentions the old value in context but never
  // the new value is presenting superseded knowledge as current.
  let staleFacts = 0;
  for (const q of questions) {
    if (!q.staleCheck) continue;
    const { context, old: oldV, new: newV } = q.staleCheck;
    for (const [f, text] of Object.entries(bodies)) {
      const t = text.toLowerCase();
      if (t.includes(context) && t.includes(oldV) && !t.includes(newV)) {
        staleFacts++;
        issues.push(`stale fact (${q.id}): ${f} mentions "${oldV}" (${context}) without "${newV}"`);
      }
    }
  }
  const bytes = (await Promise.all(memories.map((f) => stat(join(scopeDir, f))))).reduce((a, s) => a + s.size, 0);
  return { files: memories.length, bytes, staleFacts, issues };
}
