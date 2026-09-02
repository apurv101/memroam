# MemoryArena suite

Ports [MemoryArena](https://github.com/ZexueHe/MemoryArena) (arXiv
[2602.16313](https://arxiv.org/abs/2602.16313)) onto the vault eval harness.
Where LoCoMo tests *recall* (ingest transcripts, answer questions later),
MemoryArena tests *memory in use*: each task is a sequence of interdependent
subtasks, and what the agent learned solving subtask *i* is needed to solve
subtask *i+1*. Memory is the only channel between subtasks — every subtask runs
in a fresh session.

Lives beside `evals/` (which owns LoCoMo/micro) and imports its drivers and
infra (`evals/drivers/`, `evals/lib.mjs`); everything arena-specific — dataset
loading, prompts, sequential per-paper orchestration, metrics — is here.

## Suites

Dataset: [ZexueHe/memoryarena](https://huggingface.co/datasets/ZexueHe/memoryarena)
(auto-downloaded via the HF datasets-server API, cached in `datasets/`).

| suite | HF config | size | status |
|---|---|---|---|
| `math` | formal_reasoning_math | 40 papers × 5 subtasks | ported |
| `phys` | formal_reasoning_phys | 20 papers × 2–12 subtasks | ported |
| travel / shopping / search | group_travel_planner, bundled_shopping, progressive_search | 270 / 150 / 221 | **not ported** — need their Python env server (tool APIs over CSV DBs / WebShop / BrowseComp+) plus an MCP bridge so CLI agents can call the env tools |

The formal-reasoning splits are self-contained because their "environment" is
just an LLM equivalence judge — no env server required. Each paper's subtasks
are research-level math/physics questions from one arXiv paper; later
subtasks build on definitions and results established in earlier ones.

## Arms (mapping to the paper's memory systems)

- **vault** — ours. Per subtask: a fresh read-only QA session (vault MCP is the
  only memory), judge, then a *distill* session with write access that persists
  the experience — the agentic counterpart of their `memory_client.add()`.
  Judge feedback is not distilled (their default `judge_result_in_memory=false`).
- **closed_book** (`--baselines`) — their "none": every subtask cold, background only.
- **full_context** (`--baselines`) — their "long_context": all prior
  `## Task / ## Solution` entries from *this arm's own answers* pasted into the
  prompt, comparable to the paper's long-context rows.

Judge: their `MathEnvironment.judge` mathematical-equivalence prompt, recast to
our JSON verdict, hard-pinned to the claude driver (haiku by default) like the
LoCoMo suite — the instrument stays constant across cells.

## Running

```sh
# smoke: one paper, all arms
node evals_memory_arena/run.mjs --suite math --paper 1 --baselines

# full local cell (claude harness, sonnet), vault arm only
node evals_memory_arena/run.mjs --suite math

# full matrix cell with baselines
node evals_memory_arena/run.mjs --suite math --baselines

# other harness / custom backend — same flags as evals/run.mjs
node evals_memory_arena/run.mjs --suite math --harness codex
node evals_memory_arena/run.mjs --suite math --provider vast --model qwen3.5-35b-a3b

# headline table
node evals_memory_arena/analyze.mjs [--cell claude-vault-sonnet]
```

Results: `results/<harness>-<memory>-<model>[-<provider>]/<suite>…jsonl`, one
folder per matrix cell with its own `.cache/` (same layout as `evals/results/`).
Papers run in parallel (`--paper-concurrency`, default 3); subtasks within a
paper are strictly sequential. Vault state snapshots after every distill, so
crashed runs resume mid-paper; a `--papers 2` smoke shares cache with the full
run. A vault-arm error aborts that paper (a hole in the memory chain can't be
patched later) — rerun to resume it; other papers keep going.

## Metrics (their `eval.py`)

- **progress score** — mean over papers of (correct subtasks / subtasks)
- **task success** — fraction of papers whose *last* subtask is correct
- **pass-rate@k** — accuracy at each subtask position (does memory help more,
  deeper into the task?)
