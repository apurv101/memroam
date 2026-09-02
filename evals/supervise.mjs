#!/usr/bin/env node
// Cell supervisor — babysits long run.mjs matrix cells on per-second-billed
// pods, where a crashed or stalled cell idling unnoticed is the real cost.
//
//   node evals/supervise.mjs --jobs evals/jobs/locomo-swap.json
//                            [--parallel 0 (= all)] [--check 60] [--pulse 1800]
//                            [--stall 1200] [--max-attempts 6]
//                            [--down-when-done] [--dry-run]
//   node evals/supervise.mjs -- --suite locomo --harness codex ...  (single job)
//
// Jobs file: JSON array of {name?, args: [...] | "arg string"} — each entry is
// one run.mjs invocation. Everything after a bare `--` instead defines a
// single inline job.
//
// Lifecycle per job (run.mjs's per-unit cache does the heavy lifting — every
// relaunch resumes ingest snapshots and cached answers, and errored units are
// never cached, so a relaunch sweeps exactly the failures):
//   exit 0, summary has no errored units  → done
//   exit 0, summary has errored units     → sweep relaunch
//   non-zero exit                         → crash relaunch
//   no stdout/stderr for --stall seconds  → kill, relaunch (timeout cascades
//                                           and dead backends both look like
//                                           silence; healthy QA prints
//                                           per-unit lines constantly)
//   two consecutive crashes < 60s in      → failed (config error, not flake)
//   --max-attempts attempts spent         → failed
//
// Pulses print a one-line status per job every --pulse seconds. When every
// job settles, a final report prints each cell's summary tallies; with
// --down-when-done the supervisor then runs `node evals/vast.mjs down`
// (opt-in: it destroys the pod). Exit code 0 iff every job is done.
//
// Logs append to evals/results/.supervisor/<name>.log across attempts. The
// supervisor keeps no other state — restarting it relaunches unfinished jobs,
// which the cache makes cheap. Ctrl-C kills the children and exits 130.
//
// Zero dependencies. Node >= 18.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EVALS_DIR, REPO_DIR, cliArgs, loadDotEnv } from "./lib.mjs";

loadDotEnv();

const RUN = join(EVALS_DIR, "run.mjs");
const LOG_DIR = join(EVALS_DIR, "results", ".supervisor");

const dashDash = process.argv.indexOf("--");
const ownArgv = dashDash < 0 ? process.argv.slice(2) : process.argv.slice(2, dashDash);
const { opt, flag } = cliArgs(ownArgv);

const cfg = {
  jobsFile: opt("jobs", null),
  parallel: Number(opt("parallel", 0)) || Infinity, // 0 = all at once
  checkSec: Number(opt("check", 60)),
  pulseSec: Number(opt("pulse", 1800)),
  stallSec: Number(opt("stall", 1200)), // > 2× the fc-prefill qa-timeout
  maxAttempts: Number(opt("max-attempts", 6)), // 1 launch + 5 relaunches
  downWhenDone: flag("down-when-done"),
  dryRun: flag("dry-run"),
};

// ── Jobs ──────────────────────────────────────────────────────────────────────

async function loadJobs() {
  if (dashDash >= 0) {
    const args = process.argv.slice(dashDash + 1);
    if (!args.length) throw new Error("nothing after `--` — pass run.mjs args");
    return [{ name: "job", args }];
  }
  if (!cfg.jobsFile) throw new Error("--jobs <file.json> required (or a single job after `--`)");
  const raw = JSON.parse(await readFile(cfg.jobsFile, "utf8"));
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${cfg.jobsFile}: expected a non-empty JSON array`);
  return raw.map((j, i) => ({
    name: (j.name ?? `job${i + 1}`).replace(/[^a-zA-Z0-9._-]/g, "_"),
    args: Array.isArray(j.args) ? j.args : String(j.args).trim().split(/\s+/),
  }));
}

// ── Per-job state machine ─────────────────────────────────────────────────────

const now = () => Date.now();
const hms = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (msg) => console.log(`[${stamp()}] ${msg}`);

function launch(job) {
  job.attempts++;
  job.status = "running";
  job.startedAt = now();
  job.lastOutputAt = now();
  job.lastLine = "";
  job.resultsFile = null;
  job.log.write(`\n===== attempt ${job.attempts} @ ${new Date().toISOString()} =====\n`);
  // cwd = repo root so job args read like the documented commands
  // (relative --vault-from evals/results/... paths resolve correctly).
  const proc = spawn(process.execPath, [RUN, ...job.args], { cwd: REPO_DIR, stdio: ["ignore", "pipe", "pipe"] });
  job.proc = proc;
  const onData = (buf) => {
    job.lastOutputAt = now();
    job.log.write(buf);
    const lines = buf.toString().split("\n").filter((l) => l.trim());
    if (lines.length) job.lastLine = lines[lines.length - 1].slice(0, 120);
    for (const l of lines) {
      const m = l.match(/(?:^|\s)results: (.+\.jsonl)\s*$/);
      if (m) job.resultsFile = m[1];
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("exit", (code, signal) => {
    job.proc = null;
    job.exit = { code, signal, ranMs: now() - job.startedAt };
    job.status = "exited"; // settle() decides what it means on the next check
  });
  say(`${job.name}: attempt ${job.attempts}/${cfg.maxAttempts} started (pid ${proc.pid})`);
}

// Errored units in the summary record — the sweep signal. Falls back to
// "no errors" when there's no summary (e.g. --only health runs).
async function erroredUnits(job) {
  if (!job.resultsFile) return 0;
  try {
    const recs = (await readFile(job.resultsFile, "utf8")).trim().split("\n");
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = JSON.parse(recs[i]);
      if (r.type === "summary")
        return Object.values(r.tally).reduce((a, t) => a + (t.errors ?? 0), 0);
    }
  } catch {}
  return 0;
}

async function settle(job) {
  const { code, signal, ranMs } = job.exit;
  const fail = (why) => { job.status = "failed"; job.why = why; say(`${job.name}: FAILED — ${why}`); };
  if (code === 0) {
    job.fastFails = 0;
    const errs = await erroredUnits(job);
    if (errs === 0) {
      job.status = "done";
      say(`${job.name}: done after ${job.attempts} attempt(s), ${hms(ranMs)} last attempt`);
      return;
    }
    if (job.attempts >= cfg.maxAttempts) return fail(`${errs} errored units still in summary after ${job.attempts} attempts`);
    say(`${job.name}: completed with ${errs} errored units — sweep relaunch (errors are never cached)`);
    job.status = "pending";
    return;
  }
  // Crash. A quick death twice in a row is a config error, not flakiness.
  job.fastFails = ranMs < 60_000 ? (job.fastFails ?? 0) + 1 : 0;
  if (job.fastFails >= 2) return fail(`crashed twice within 60s of launch (exit ${code ?? signal}) — likely a config error, see log`);
  if (job.attempts >= cfg.maxAttempts) return fail(`exit ${code ?? signal} with no attempts left`);
  say(`${job.name}: exit ${code ?? signal} after ${hms(ranMs)} — relaunching`);
  job.status = "pending";
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const jobs = await loadJobs();
  if (cfg.dryRun) {
    for (const j of jobs) console.log(`${j.name}: node evals/run.mjs ${j.args.join(" ")}`);
    return;
  }
  await mkdir(LOG_DIR, { recursive: true });
  for (const j of jobs) Object.assign(j, {
    status: "pending", attempts: 0, fastFails: 0,
    log: createWriteStream(join(LOG_DIR, `${j.name}.log`), { flags: "a" }),
  });
  say(`supervising ${jobs.length} job(s) — check ${cfg.checkSec}s, stall ${cfg.stallSec}s, pulse ${cfg.pulseSec}s, cap ${cfg.maxAttempts} attempts; logs in ${LOG_DIR}`);

  const killAll = () => jobs.forEach((j) => j.proc?.kill());
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => { say(`${sig} — killing children`); killAll(); process.exit(130); });

  let lastPulse = now();
  for (;;) {
    for (const job of jobs) {
      if (job.status === "running" && now() - job.lastOutputAt > cfg.stallSec * 1000) {
        say(`${job.name}: no output for ${hms(now() - job.lastOutputAt)} — stalled, killing`);
        job.proc?.kill(); // exit handler flips it to "exited"; settle() relaunches
      }
      if (job.status === "exited") await settle(job);
    }
    while (jobs.filter((j) => j.status === "running").length < cfg.parallel) {
      const next = jobs.find((j) => j.status === "pending");
      if (!next) break;
      launch(next);
    }
    if (jobs.every((j) => j.status === "done" || j.status === "failed")) break;
    if (now() - lastPulse >= cfg.pulseSec * 1000) {
      lastPulse = now();
      for (const j of jobs)
        say(`pulse ${j.name}: ${j.status}, attempt ${j.attempts}/${cfg.maxAttempts}` +
          (j.status === "running" ? `, up ${hms(now() - j.startedAt)} — ${j.lastLine}` : ""));
    }
    await new Promise((r) => setTimeout(r, cfg.checkSec * 1000));
  }

  console.log("\n== supervisor report ==");
  for (const job of jobs) {
    console.log(`${job.name}: ${job.status}${job.why ? ` (${job.why})` : ""} — ${job.attempts} attempt(s)`);
    if (job.resultsFile) {
      try {
        const recs = (await readFile(job.resultsFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
        const sum = recs.reverse().find((r) => r.type === "summary");
        for (const [system, t] of Object.entries(sum?.tally ?? {}))
          console.log(`  ${system}: ${t.correct}/${t.total}${t.errors ? ` (${t.errors} errors)` : ""}`);
        console.log(`  results: ${job.resultsFile}`);
      } catch {}
    }
    job.log.end();
  }

  if (cfg.downWhenDone) {
    say("all jobs settled — running `node evals/vast.mjs down`");
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(EVALS_DIR, "vast.mjs"), "down"], { stdio: "inherit" });
      p.on("exit", resolve);
    });
  }
  process.exit(jobs.every((j) => j.status === "done") ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
