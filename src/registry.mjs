// Machine-level record of this machine's wiring — advisory, not authoritative
// (repos move and vanish), so readers treat entries as hints. Lives outside
// the store: it describes wiring, not memories. Fields: connections (repos
// that ran per-repo install), store (the store path recorded by install
// --global, so stdio instances find it without env), spaces (project root →
// space name, written by stdio auto-detection so renames and basename
// collisions stay stable), global (what install --global wired).

import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWrite, exists } from "./store.mjs";

export const projectSlug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);

export const CONNECTIONS_PATH = join(homedir(), ".memroam-connections.json");
// memory-vault-era installs wrote this path; readRegistry falls back to it,
// and the next write migrates the registry to the new name and removes it.
const LEGACY_CONNECTIONS_PATH = join(homedir(), ".memory-vault-connections.json");

export async function readRegistry() {
  for (const path of [CONNECTIONS_PATH, LEGACY_CONNECTIONS_PATH]) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

export async function writeRegistry(registry) {
  await atomicWrite(CONNECTIONS_PATH, JSON.stringify(registry, null, 2) + "\n");
  await rm(LEGACY_CONNECTIONS_PATH, { force: true }).catch(() => {});
}

export async function readConnections() {
  const registry = await readRegistry();
  return Array.isArray(registry.connections) ? registry.connections : [];
}

export async function writeConnections(connections) {
  const registry = await readRegistry();
  registry.connections = connections;
  await writeRegistry(registry);
}

// ── stdio scope detection ─────────────────────────────────────────────────────
//
// A stdio instance is spawned by the harness in the session's directory, so
// the working directory is the one signal that identifies the project — walk
// up to the first .git (or, failing that, the shallowest package manifest)
// and name the space after that directory.

async function findProjectRoot(cwd) {
  let dir = resolve(cwd);
  let manifestRoot = null;
  while (true) {
    if (await exists(join(dir, ".git"))) return dir;
    if (await exists(join(dir, "package.json")) || (await exists(join(dir, "pyproject.toml")))) manifestRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) return manifestRoot;
    dir = parent;
  }
}

export async function resolveSpace(cwd) {
  const root = await findProjectRoot(cwd);
  if (root === null) return "default";
  const registry = await readRegistry();
  registry.spaces ??= {};
  if (typeof registry.spaces[root] === "string") return registry.spaces[root];
  // "shared" is the org-wide space; a project that happens to carry that name
  // must not scope onto it.
  const taken = new Set(["shared", ...Object.values(registry.spaces)]);
  let space = projectSlug(basename(root)) || "default";
  for (let i = 2; taken.has(space); i++) space = `${projectSlug(basename(root))}-${i}`;
  registry.spaces[root] = space;
  await writeRegistry(registry);
  return space;
}
