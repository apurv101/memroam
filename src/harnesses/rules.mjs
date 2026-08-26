// The ritual. AGENTS.md carries it (Codex, Cursor, and the growing
// cross-harness convention); CLAUDE.md imports it via @AGENTS.md so the
// text lives in one place.

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MARKED_SECTION, MEMORY_SECTION } from "../instructions.mjs";

export async function installRules({ cwd, project, dryRun }) {
  const lines = [];
  const agentsPath = join(cwd, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8").catch(() => null);
  if (agents === null) {
    if (!dryRun) await writeFile(agentsPath, `# ${project}\n\n${MARKED_SECTION}`);
    lines.push("rules    AGENTS.md created with the memory section");
  } else if (!/vault|memroam/i.test(agents)) {
    if (!dryRun) await writeFile(agentsPath, `${agents.trimEnd()}\n\n${MARKED_SECTION}`);
    lines.push("rules    AGENTS.md memory section appended");
  } else {
    lines.push("rules    AGENTS.md unchanged");
  }

  const claudeMdPath = join(cwd, "CLAUDE.md");
  const claudeMd = await readFile(claudeMdPath, "utf8").catch(() => null);
  if (claudeMd === null) {
    if (!dryRun) await writeFile(claudeMdPath, "@AGENTS.md\n");
    lines.push("rules    CLAUDE.md created (imports @AGENTS.md)");
  } else if (!/vault|memroam/i.test(claudeMd) && !claudeMd.includes("@AGENTS.md")) {
    if (!dryRun) await writeFile(claudeMdPath, `${claudeMd.trimEnd()}\n\n@AGENTS.md\n`);
    lines.push("rules    CLAUDE.md @AGENTS.md import appended");
  } else {
    lines.push("rules    CLAUDE.md unchanged");
  }
  return lines;
}

export async function uninstallRules({ cwd, project, dryRun }) {
  const lines = [];
  const agentsPath = join(cwd, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8").catch(() => null);
  let sectionRemoved = false;
  let agentsDeleted = false;
  if (agents === null) {
    lines.push("rules    AGENTS.md not present");
  } else {
    // Marker-delimited sections first (written by install going forward),
    // exact text of the current section as fallback for older installs.
    const marked = /(?:^|\n)<!-- memory-vault:begin -->\n[\s\S]*?<!-- memory-vault:end -->\n?/;
    let cleaned = null;
    if (marked.test(agents)) cleaned = agents.replace(marked, "\n");
    else if (agents.includes(MEMORY_SECTION)) cleaned = agents.replace(MEMORY_SECTION, "");
    if (cleaned === null) {
      lines.push(
        /vault|memroam/i.test(agents)
          ? "rules    AGENTS.md mentions memroam but not the standard section — edit by hand"
          : "rules    AGENTS.md no memory section",
      );
    } else {
      sectionRemoved = true;
      const rest = cleaned.trim();
      if (rest === "" || rest === `# ${project}`) {
        if (!dryRun) await rm(agentsPath);
        agentsDeleted = true;
        lines.push("rules    AGENTS.md deleted (only held the memory section)");
      } else {
        if (!dryRun) await writeFile(agentsPath, cleaned.replace(/\n{3,}/g, "\n\n").trim() + "\n");
        lines.push("rules    AGENTS.md memory section removed");
      }
    }
  }

  const claudeMdPath = join(cwd, "CLAUDE.md");
  const claudeMd = await readFile(claudeMdPath, "utf8").catch(() => null);
  if (claudeMd === null) {
    lines.push("rules    CLAUDE.md not present");
  } else if (claudeMd.trim() === "@AGENTS.md" && (agentsDeleted || sectionRemoved)) {
    if (!dryRun) await rm(claudeMdPath);
    lines.push("rules    CLAUDE.md deleted (only imported AGENTS.md)");
  } else if ((agentsDeleted || sectionRemoved) && /\n@AGENTS\.md\s*$/.test(claudeMd)) {
    if (!dryRun) await writeFile(claudeMdPath, claudeMd.replace(/\n+@AGENTS\.md\s*$/, "\n"));
    lines.push("rules    CLAUDE.md @AGENTS.md import removed");
  } else if (/vault|memroam/i.test(claudeMd)) {
    lines.push("rules    CLAUDE.md mentions memroam — review by hand");
  } else {
    lines.push("rules    CLAUDE.md unchanged");
  }
  return lines;
}
