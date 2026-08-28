# Memroam Evals — Design & Execution Plan

This is the design doc that `run.mjs` cites ("Memory Vault — Eval Execution Plan"). Part I
records the design rules and results of the existing single-harness suites; Part II is the
design for the next stage: **cross-harness evals** — measuring memory written in one harness
and consumed in another, which is the product's core claim and, as far as we can find,
something no published benchmark measures.

Status: design approved 2026-08-27. Part I is implemented (`run.mjs`, `analyze.mjs`);
Part II is not yet implemented.

---

## Part I — What exists today (Stage 0–2)

### Design rules

- **The harness prompt stays thin.** The ritual under test (recall at session start, save at
  session end, one fact per file, update-not-duplicate, delete what's wrong) is the server's
  own MCP `instructions` string — never duplicated into eval prompts. The eval measures the
  product, not the eval author's prompt engineering.
- **Fresh context per question; the vault is the only channel** between ingest and QA.
- **Provenance record is line #1 of every results JSONL** — config hash, prompts version,
  models, harness git SHA, CLI versions, and an explicit contamination field (subscription
  mode auto-loads `~/.claude/CLAUDE.md`; `--bare` is the clean room).
- **Per-unit resume cache** under `results/.cache/<configHash>/` — vault snapshots and
  answer+verdict records — so crashed or re-judged runs resume. Prompt changes bump
  `PROMPTS_VERSION`, which invalidates the cache.
- Zero dependencies, Node ≥ 18.

### Suites and arms

- `micro` — hand-written 1-conversation / 3-session / 5-question smoke suite covering
  single-hop, multi-session, knowledge-update (two superseded facts), and abstention (a
  deliberate near-miss distractor).
- `locomo` — LoCoMo-10 (1,986 questions), category 5 remapped to `NOT_IN_MEMORY` gold
  (abstention under adversarial traps).
- Three arms, same QA prompt shape and judge: `vault` (memory ingested by the agent, QA
  read-only), `closed_book` (floor / confabulation detector), `full_context` (transcript
  stuffing — the ceiling for answerable questions).

### Metrics

LLM-judge accuracy (haiku judge, forced-JSON verdicts, abstention rule for `NOT_IN_MEMORY`
gold); overall vs answerable-only; per-category and per-conversation breakdowns;
deterministic vault-health checks (index integrity, frontmatter, duplicate slugs, and a
stale-fact counter driven by per-question `staleCheck: {context, old, new}`); cost per
question and per arm.

### Headline result (LoCoMo-10, sonnet QA/ingest, haiku judge, 2026-08-19)

| arm | overall | answerable-only | adversarial (abstention) | QA cost/question |
|---|---|---|---|---|
| closed_book | 22.6% | 0.1% | 100% | $0.043 |
| full_context | 69.7% | 81.5% | **29.1%** | $0.256 |
| vault | 62.9% | 60.1% | **72.4%** | $0.083 |

The vault loses ~7 points of raw recall to context-stuffing but wins decisively on *not
making things up* (full-context confabulates on 71% of unanswerable questions) at ~⅓ the
per-query cost, with ingest nearly free ($2.26 total). Vault health across all 10
conversations: 89 files, 0 stale facts, 0 index issues.

### Known debt (gates Part II headline numbers)

**Judge calibration is unfinished.** `results/calibration-c1.md` is a 30-row stratified
sample laid out for hand-labeling with a stated bar of ≥90% human–judge agreement; zero rows
are labeled, and several verdicts look questionable on inspection. No cross-harness headline
number ships before the calibration set is labeled and agreement is recorded in provenance.

---

## Part II — Cross-harness evals (Stage 3+)

### 1. Motivation and precedents

Everything in Part I runs in one harness: headless `claude -p`. Memroam's thesis is one
memory that roams across harnesses; nothing yet measures a memory written in Codex being
read in Claude Code, or a task started in one harness and finished in another.

**No direct precedent exists.** The closest published work comes from four directions, and
cross-harness memory sits in the empty intersection:

1. **Memory benchmarks (memory system varies, harness fixed):**
   [LoCoMo](https://www.emergentmind.com/topics/locomo-and-longmemeval-_s-benchmarks),
   [LongMemEval](https://www.emergentmind.com/topics/longmemeval) (and V2),
   [BEAM](https://mem0.ai/blog/ai-memory-benchmarks-in-2026) (ICLR 2026, conversations to
   10M tokens), MemoryAgentBench. All conversational QA over a single system in a single
   harness.
2. **[MemoryArena](https://arxiv.org/abs/2602.16313) — closest in task design:**
   interdependent multi-session *agentic* tasks where memory acquired in session k is
   causally required in session k+1; evaluates Letta, Mirix, Mem0(-G), GraphRAG; finds
   uniformly low task-success rates, exposing the gap between recall benchmarks and
   memory-guided action. Single harness. Our relay suite (§5b) is "MemoryArena, but the
   sessions hop harnesses."
3. **Harness benchmarks (harness varies, no memory):** Terminal-Bench;
   [Artificial Analysis's Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents),
   which holds the model constant across Cursor / Claude Code / OpenCode — the inverse of
   the memory benchmarks, and the precedent for our diagonal-normalization reporting (§6).
   [Coder Eval](https://coder-eval.com/) runs the same declarative YAML task in Claude
   Code / Codex / Gemini sandboxes — the closest *infrastructure* precedent.
4. **Continuity / lifelong evals:** LifelongAgentBench-style sequential task streams
   (forward/backward transfer, forgetting); checkpoint-resume engineering patterns.
   Cross-session, single harness.

### 2. Harness set

| Role | Harness | Headless entry | Native model |
|---|---|---|---|
| matrix | Claude Code | `claude -p` | Claude (recorded per run) |
| matrix | Codex CLI (0.149.1) | `codex exec` | GPT (recorded per run) |
| matrix | Gemini CLI (0.56.0) | `gemini -p` | Gemini (recorded per run) |
| ablation | OpenCode (1.17.15) | `opencode run` | Claude via Bedrock — same-model control vs Claude Code |

OpenCode is an ablation, not a fourth matrix row: 3×3 = 9 cells stays affordable and the
Bedrock-Claude arm is what separates harness behavior from model capability (§6).
cursor-agent is out of scope for v1 (not installed). The hosted tier
(claude.ai / ChatGPT connectors over `https://memroam.com/mcp`) is not automatable and is
covered only by manual spot checks.

Never hardcode model IDs: all three CLIs report resolved models in their JSON output;
record what comes back into provenance.

### 3. Driver mechanics (verified against `--help` / binary inspection, 2026-08-27)

Thin per-harness drivers under `evals/drivers/`, one file each, zero deps:

```js
// drivers/index.mjs — each driver exposes:
// async run({ prompt, mcpUrl, model, nativeTools /* "none"|"code" */,
//             workDir, timeoutMs, label })
//   -> { text, isError, costUsd?, usage?, models: [resolvedIds], durationMs, raw? }
```

Prompt goes via stdin everywhere (avoids arg-length and quoting issues). Verified
invocations:

```
claude   -p --output-format json --model M --tools "" --no-session-persistence \
         --mcp-config <workDir>/mcp.json --strict-mcp-config [--allowedTools ...]

codex    exec --ignore-user-config --ephemeral --skip-git-repo-check --color never \
         -C <workDir> -s read-only --json -o <workDir>/last.txt \
         [-m M] -c 'mcp_servers.vault.url="<mcpUrl>"' -

gemini   -p <stdin> -o json [-m M] --approval-mode yolo --skip-trust \
         --allowed-mcp-server-names vault
         # cwd = workDir containing .gemini/settings.json with
         # {"mcpServers": {"vault": {"httpUrl": "<mcpUrl>"}}}

opencode run --format json [-m provider/model] <prompt>
         # cwd = workDir; env OPENCODE_CONFIG_CONTENT='{"mcp":{"vault":{"type":"remote",
         #   "url":"<mcpUrl>"}}, "tools": {...all false...}}',
         # OPENCODE_DISABLE_PROJECT_CONFIG=1
```

Hermeticity / contamination notes (recorded per driver in provenance):

- **codex**: `--ignore-user-config` is a real clean room (auth still loads from
  `CODEX_HOME`). Cleanest of the four.
- **gemini**: user `~/.gemini/settings.json` and global `GEMINI.md` merge;
  `--allowed-mcp-server-names vault` blocks the user's other MCP servers. Strongest lever
  if needed: `GEMINI_CLI_SYSTEM_SETTINGS_PATH`.
- **opencode**: point `OPENCODE_CONFIG` at our own file to replace the global lookup;
  `OPENCODE_DISABLE_PROJECT_CONFIG=1` for repo config.
- **claude**: existing subscription-mode CLAUDE.md contamination note; `--bare` clean room.

**Enforcement is server-side, not per-driver.** Only Claude Code supports per-MCP-tool
allowlists; Codex has none, and fighting four permission systems is the wrong altitude. Two
small env-gated additions to the server instead:

1. **Read-only scope** — `POST /mcp-ro/<scope>`: `tools/list` returns only
   `view`/`search`/`fetch`; write tools are rejected. QA arms point every harness at the RO
   URL, so read-only-ness is provable regardless of harness. (~15 lines across
   `src/transports.mjs` / `src/dispatch.mjs`, filtering `TOOLS`.)
2. **Request log** — when `MEMROAM_LOG_FILE` is set, append JSONL
   `{ts, scope, method, tool, argsSummary, label}` per `tools/call`. Archived next to the
   vault snapshot; powers the ritual-compliance metrics (§5d).

Driver-level neutralization of native tools stays as defense in depth: empty temp CWD
everywhere, `--tools ""` (claude), `-s read-only` (codex), workspace `coreTools: []`
(gemini), all-false tools map (opencode).

A `drivers/smoke.mjs` gate runs per harness before anything else: throwaway vault → "save
fact X" (RW URL) → fresh session "what is X?" (RO URL) → assert round-trip plus parseable
cost/model fields. All settings-key details flagged "verify at smoke time" get pinned here.

**Hypothesis the smoke test will surface:** Gemini CLI and possibly Codex may not inject MCP
server `instructions` into the system prompt the way Claude Code does. Since the ritual
under test *is* those instructions, ritual compliance (§5d) doubles as a measurement of each
harness's instructions plumbing — and the rules-file arm (§5d) is the product's mitigation,
tested as such.

### 4. Matrix design

Writer harness **W** ingests the sessions into a fresh vault; reader harness **R** answers
questions over that vault in fresh sessions. `T[W][R]` = accuracy of cell (W, R).

- Diagonal `T[R][R]` = same-harness baseline.
- **Transfer penalty** (headline): `Δ(W,R) = T[R][R] − T[W][R]`, with the ratio
  `T[W][R] / T[R][R]` reported alongside. Controls for reader capability.
- Fixed strong reader (claude column) isolates **write quality** per writer; fixed writer
  (claude row) isolates **read quality** per reader.

Affordability: split the cache key so ingest is per-writer, not per-cell —
`ingestHash(suite, writer, writerModel, PROMPTS_VERSION)` owns the vault snapshots;
`cellHash(ingestHash, reader, readerModel, judge, bare, PROMPTS_VERSION)` owns QA/judge
records. N ingests, not N².

| Layer | Cells | Suite | Est. cost |
|---|---|---|---|
| Micro matrix | all pairs incl. opencode (16) | micro | ~$5–15 |
| QA matrix | 3×3 | `locomo200` | ~$100–150 |
| Relay | 3×3 ordered pairs | 5 tasks × ~3 sessions | ~$50–150 |
| Research relay | 3 diagonal + 6 off-diagonal | 3 fixtures | ~$20 |

`locomo200` = deterministic stratified subset: for each of the 10 conversations, the first
4 questions per category (5 categories) sorted by id → 200 questions; subset ids listed in
provenance.

### 5. Task families

**(a) Cross-harness QA.** Minimal extension of `run.mjs`: `--writer <harness>` /
`--reader <harness>` (+ `--writer-model`/`--reader-model`), the cache-key split above, and a
thin `evals/matrix.mjs` orchestrator that expands `--harnesses claude,codex,gemini` into
cells and shells `run.mjs` per cell (the cache makes re-entry free). Results filename
`<suite>-w_<writer>-r_<reader>.jsonl`; provenance gains writer/reader, resolved model IDs,
per-driver contamination notes, and each CLI's version.

**(b) Agentic relay / handoff** — new suite `evals/relay/`, MemoryArena-style interdependent
sessions where session k runs in harness h_k against a small repo fixture. Sessions share
the temp repo copy (`nativeTools: "code"`) — code moves through the filesystem; *decisions,
constraints, and rationale move only through the vault*. Control arm: identical relay with
no MCP server → `vaultLift = score − control score`. Fixtures
(`evals/relay/fixtures/<task>/` = `repo/` + `task.json` + `checks.mjs`, deterministic
checks via `node --test` / grep / diff-scope):

1. **config-conventions** — S1 (A, exploration only, no edits) decides and records
   conventions (env-var prefix, key casing, error style); S2 (B) implements the config
   loader. Checks: tests + greps. Pure-vault channel (S1 changed no code).
2. **api-error-contract** — S1 (A) records error envelope + status-code table; S2 (B)
   implements `/users`; S3 (C) implements `/orders`. Check: contract test asserts both
   endpoints emit the *identical* envelope — cross-harness consistency is the point.
3. **bugfix-constraint** — S1 (A) diagnoses a failing test and records a constraint ("fix
   in parser.mjs only; public signature unchanged"); S2 (B) fixes. Checks: test green +
   diff touches only parser.mjs + signature unchanged.
4. **refactor-relay** — S1 (A) records a plan with a gotcha ("`slugify` also called from
   export.mjs — keep behavior"); S2 (B) does half, records progress; S3 finishes. Checks:
   full suite + gotcha regression test.
5. **naming-glossary** — S1 (A) records terminology decisions; S2 (B) writes README +
   `--help` strings. Checks: chosen term present, rejected synonym absent.

Per-task scores: `endToEnd` (0/1 per check), `vaultConsulted` (from the request log: a read
before the first non-vault action in every session ≥ 2), `vaultLift`.

**(c) Research relay** — `evals/research/fixtures/<name>/`. A corpus of 6–10 short local
markdown docs is inlined into S1's prompt (keeps `nativeTools: "none"`; no live web, fully
reproducible): S1 (A) "read these documents, persist what matters"; S2 (B, corpus absent)
"write the briefing". Scored deterministically against `facts.json` (~20 gold facts, each
with regex `patterns`, superseded-fact traps scored as errors if the old value surfaces,
plus one abstention trap). Fixtures: **vendor-selection** (facts spread over 4 docs + one
superseding memo), **incident-timeline** (dates/ordering), **competitor-brief** (numbers +
a metric never stated).

**(d) Ritual compliance per harness** — computed from the server request log in
`analyze.mjs`, per harness per role:

- `recalledFirst` — session's first vault op is a read, before any write / final answer;
- `savedAtEnd` — ingest session performed ≥ 1 write;
- `updateRate` — on superseding sessions, `str_replace`/`insert` on the existing file vs a
  duplicate `create` (pairs with the stale-fact counter);
- `toolErrors` — error-result rate (schema-compat signal: did the harness form valid calls).

Plus a **rules-file arm** (`--installed`, relay suite): the workDir/repo additionally gets
the harness's real rules file via the `src/harnesses/` writers — measuring the install path
against MCP-instructions-only, and serving as the mitigation test if a harness ignores MCP
instructions.

**(e) Mixed-writer vault health** — micro suite with `--writers claude,codex,gemini` (one
harness per session; sessions 2–3 carry the supersessions). Existing `healthCheck` metrics
(stale facts, duplicate slugs, index integrity) reported per writing harness, with the
request log attributing each file to its writer. Optional later: one extra micro
conversation with overlapping facts phrased differently per session to stress dedup.

### 6. Confounds and reporting

Native models mean model capability is confounded with harness memory behavior. Handled
three ways, all stated in the report:

1. **Diagonal normalization** — Δ and the ratio control for reader capability (§4).
2. **Same-model ablation** — OpenCode running Bedrock Claude vs Claude Code running the
   same Claude model, on the micro matrix + one LoCoMo conversation: any gap is harness
   behavior, not model. (Verify AWS creds are live before scheduling.)
3. **Stated limitation** — Codex and Gemini CLI cannot run foreign frontier models; the
   off-diagonal cells therefore measure the *product experience* (harness + its native
   model), which is also what a user of those harnesses actually gets.

Per-category breakdowns as today. The most interesting expected cell: adversarial
abstention transfer, given the Part I result (72.4% vault vs 29.1% full-context).

### 7. Phased build plan (for when implementation is approved)

- **P0 — foundations (0.5–1 d):** label the calibration set (§ Part I debt); server
  read-only scope + `MEMROAM_LOG_FILE`; extract shared helpers from `run.mjs` into
  `evals/lib.mjs` (behavior unchanged).
- **P1 — drivers (1–2 d):** `drivers/{claude,codex,gemini,opencode}.mjs` + `smoke.mjs`;
  pin all "verify at smoke time" keys; record resolved default models.
- **P2 — micro matrix (1 d, ~$10):** `--writer`/`--reader`/`--writers` + cache split +
  `matrix.mjs`; full micro matrix incl. ablation cell and mixed-writer run, with compliance
  metrics. *Cheapest high-signal step: answers "does a Codex-written vault work in Claude
  and vice versa" and "does Gemini even see the ritual".*
- **P3 — QA matrix (1–2 d, ~$150):** `locomo200`; 3×3; matrix/Δ tables in `analyze.mjs`.
  First headline transfer-penalty numbers.
- **P4 — relay suite (2–3 d):** 5 fixtures + relay runner + control arm + `--installed`.
- **P5 — research relay (1 d):** 3 fixtures + fact-coverage scorer.
- **P6 — writeup (0.5 d):** consolidated report; contamination/limitations section.

Files to add: `evals/lib.mjs`, `evals/drivers/*`, `evals/matrix.mjs`, `evals/relay/*`,
`evals/research/*`. Files to modify: `evals/run.mjs`, `evals/analyze.mjs`,
`src/transports.mjs`, `src/dispatch.mjs` (RO filter may fit best next to `TOOLS` in
`src/store.mjs`).
