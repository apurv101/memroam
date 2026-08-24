// The harness registry — one file per harness, connected here. Each harness
// owns four hooks: detect (is it on this machine / in this repo), install /
// uninstall (write and remove its repo-level MCP registration), and
// globalInstall / globalUninstall (the user-global stdio registration plus
// the ritual in its global rules file). The shared repo rules files
// (AGENTS.md + CLAUDE.md) live in rules.mjs because every harness reads the
// same text. Adding a harness = one new file here plus one line in the list.

import claude from "./claude.mjs";
import cursor from "./cursor.mjs";
import codex from "./codex.mjs";
import dsh from "./dsh.mjs";
import opencode from "./opencode.mjs";
import gemini from "./gemini.mjs";
import antigravity from "./antigravity.mjs";

// Order matters: it is the picker's numbering and the install/report order.
export const HARNESSES = [claude, cursor, codex, dsh, opencode, gemini, antigravity];

export { dshProfiles } from "./dsh.mjs";
export { installRules, uninstallRules } from "./rules.mjs";
