#!/usr/bin/env node
// Memroam — Claude-style memory primitives over a local folder, via MCP.
//
//   npx memroam install --global — wire every harness on this machine to
//                                    the vault once, user-globally: a stdio MCP
//                                    registration per harness plus the memory
//                                    ritual in its global rules file. Sessions
//                                    then get vault tools in every repo with no
//                                    per-repo setup; the stdio server derives
//                                    the project space from its working
//                                    directory automatically.
//   npx memroam stdio         — MCP over stdin/stdout (what the global
//                                    registrations run; spawned by the harness
//                                    in the session's directory)
//   node server.mjs                (or: npm start) — serve the vault over HTTP
//   npx memroam install       — wire the current repo to the vault
//                                    (starts the server if down, lets you pick
//                                    harnesses, writes each one's MCP config +
//                                    the shared rules files; alias: connect)
//   npx memroam uninstall     — undo install for the repo (--global: undo
//                                    install --global); memories are never
//                                    touched (alias: disconnect)
//
// The store is a plain directory of markdown files (default ./memory), one
// subdirectory per project plus an org-wide shared/ space, each with its own
// MEMORY.md index. The server exposes the same core commands as Claude's
// memory tool — view, create, str_replace, insert, delete, rename. The model
// does the rest, exactly as Claude does natively: it keeps the index, one
// file per memory, and decides what deserves saving.
//
// Scoping: POST /mcp/<project> sandboxes a session to memory/<project>/ plus
// the read-write shared/ space; bare POST /mcp is the unscoped whole-vault
// (gardener) view.
//
// Env:
//   MEMORY_DIR   the memory folder (default ./memory)
//   VAULT_PORT   listen port on 127.0.0.1 (default 8787)
//
// MCP: stateless Streamable HTTP — POST one JSON-RPC message per request.
// Connect (per repo): claude mcp add --transport http --scope project memroam http://localhost:8787/mcp/<project>
//
// This file is the bin entry; the implementation lives in src/:
//   store.mjs         the memory engine — path sandbox + the six commands
//   instructions.mjs  every ritual/instruction string, in one place
//   transports.mjs    MCP dispatch over Streamable HTTP and stdio
//   harnesses.mjs     the per-harness install/uninstall registry
//   registry.mjs      ~/.memroam-connections.json + space detection
//   cli.mjs           install/uninstall/status + command dispatch

import { fileURLToPath } from "node:url";
import { runCli } from "./src/cli.mjs";

await runCli(process.argv.slice(2), fileURLToPath(import.meta.url));
