// The ritual — every instruction string the vault hands to a model or writes
// into a harness's rules file. One place, so the text never forks.

export const instructionsFor = (scope) =>
  scope
    ? `You have Memroam — a persistent vault of memories that roams with you across sessions. This session's project space is "${scope}" — relative paths read and write there. MEMORY.md at its root is this project's index — view it before starting work, and read any memory file it points to that looks relevant. The whole vault is visible: other projects' spaces can be addressed by path ("<space>/<file>"), and the root listing shows every space. When the index isn't enough, the search tool finds memories by keyword across the whole vault, and fetch returns any memory in full by its id (its path). At the start of a conversation, recall what's relevant to the topic; before it ends, save what should be remembered.

Each memory is one markdown file holding one fact, with frontmatter (name: kebab-case slug, description: one-line summary), stored at the root of the directory. MEMORY.md is generated automatically from that frontmatter — never edit it directly; write a sharp one-line description:, it becomes the index line. Before saving, check whether an existing file already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong.

The shared/ directory is org-wide memory visible to every project, with its own shared/MEMORY.md index — check it for relevant org facts, and store facts that apply beyond this project there.

Store durable facts, corrections, lessons, and decisions — things that should outlive this session and be visible to every future session in every harness. Don't store what the repo or chat history already records.`
    : `You are viewing the whole Memroam vault. Each subdirectory is one project's memory space with its own MEMORY.md index; shared/ is org-wide memory visible to every project. The root MEMORY.md lists the spaces — view it and the relevant space's MEMORY.md before starting work. When the indexes aren't enough, the search tool finds memories by keyword across the whole vault, and fetch returns any memory in full by its id (its path). At the start of a conversation, recall what's relevant to the topic; before it ends, save what should be remembered.

Each memory is one markdown file holding one fact, with frontmatter (name: kebab-case slug, description: one-line summary). Each space's MEMORY.md is generated automatically from that frontmatter — never edit it directly; write a sharp one-line description:, it becomes the index line. Before saving, check whether an existing file already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong.

Store durable facts, corrections, lessons, and decisions — things that should outlive this session and be visible to every future session in every harness. Don't store what the repo or chat history already records.`;

export const MEMORY_SECTION = `## Memory

This repo uses the Memroam MCP server (\`memroam\`) for persistent memory. At session start, view \`MEMORY.md\` with the memroam tools and read any entries relevant to the task. Before finishing, save durable facts, corrections, lessons, and decisions to the vault — one markdown file per fact with \`name:\`/\`description:\` frontmatter (\`MEMORY.md\` regenerates automatically; the description becomes the index line). Check whether an existing memory already covers it before creating a new one. Facts that apply beyond this project go in \`shared/\`. Prefer memroam over any built-in auto-memory.
`;

// Markers around the written section let uninstall remove it verbatim even if
// the section text changes in a future version. (Sections written before the
// markers existed are removed by exact-text match instead.) Sections from the
// memory-vault era carry the old marker name — MARKED_SECTION_RE matches both.
export const MARK_BEGIN = "<!-- memroam:begin -->";
export const MARK_END = "<!-- memroam:end -->";
export const MARKED_SECTION_RE = /(?:^|\n)<!-- (?:memroam|memory-vault):begin -->\n[\s\S]*?<!-- (?:memroam|memory-vault):end -->\n?/;
export const MARKED_SECTION = `${MARK_BEGIN}\n${MEMORY_SECTION}${MARK_END}\n`;

// The user-global ritual differs from the repo one: no fixed project name
// (stdio scopes each session automatically) and it points at per-repo install
// only as the opt-out for a custom space name.
export const GLOBAL_MEMORY_SECTION = `## Memory

A Memroam MCP server (\`memroam\`) provides persistent cross-session memory; when its tools are available, prefer them over any built-in auto-memory. Memories are scoped to a per-project space automatically (detected from the session's directory); \`shared/\` is cross-project memory visible everywhere. At session start, view \`MEMORY.md\` with the memroam tools and read any entries relevant to the task; also check \`shared/MEMORY.md\`. Before finishing, save durable facts, corrections, lessons, and decisions — one markdown file per fact with \`name:\`/\`description:\` frontmatter (\`MEMORY.md\` regenerates automatically; the description becomes the index line). Check whether an existing memory already covers it before creating a new one; delete memories that turn out to be wrong. Don't store what the repo or chat history already records.
`;
export const GLOBAL_MARKED_SECTION = `${MARK_BEGIN}\n${GLOBAL_MEMORY_SECTION}${MARK_END}\n`;

// Cursor has no writable always-on rules file, but it loads personal skills
// from ~/.cursor/skills/ — so the ritual ships as a skill with a broad
// trigger description. On-demand, not guaranteed-injected; the report still
// points at Settings → Rules for the always-on variant.
export const CURSOR_RITUAL_SKILL = `---
name: memroam
description: >-
  Persistent cross-session memory via the Memroam MCP server. Use at the start
  of any coding task to recall project memory and context from previous
  sessions, whenever the user mentions remembering, memory, or past
  decisions, and before finishing work to save durable facts, corrections,
  lessons, and decisions.
---
# Memroam

A Memroam MCP server (\`memroam\`) provides persistent cross-session memory shared across coding agents. Memories are scoped to a per-project space automatically (detected from the session's directory); \`shared/\` is cross-project memory visible everywhere.

At the start of a task: view \`MEMORY.md\` with the memroam tools and read any entries relevant to the task; also check \`shared/MEMORY.md\`.

Before finishing: save durable facts, corrections, lessons, and decisions — one markdown file per fact with \`name:\`/\`description:\` frontmatter (\`MEMORY.md\` regenerates automatically; the description becomes the index line). Check whether an existing memory already covers it before creating a new one; delete memories that turn out to be wrong. Don't store what the repo or chat history already records.
`;
