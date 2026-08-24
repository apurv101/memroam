// The adapter registry — storage tier, not harness name, picks the shape
// (design contract item 1): plain-files → copy importer, structured-local-
// derived → read-only version-gated reader, no-native-memory → export-side
// projection. Adapters are deterministic code only: ingestion, version
// gates, projection. No model judgment here — promoting candidates is the
// gardener's job. Every run returns a capability report: what the adapter
// can and cannot move (the machine-readable half of the lossless-exit
// promise, item 8).

import claude from "./claude.mjs";
import codex from "./codex.mjs";
import dsh from "./dsh.mjs";

export const ADAPTERS = [claude, codex, dsh];

export async function runAdapters(kind, { dryRun }) {
  const reports = [];
  for (const a of ADAPTERS) {
    if (a.kind !== kind) continue;
    try {
      reports.push(await a.run({ dryRun }));
    } catch (err) {
      reports.push({ adapter: a.key, error: err.message });
    }
  }
  return reports;
}
