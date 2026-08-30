// GitHub App authentication: the app-level credentials live in Secrets
// Manager; user sign-in uses the App's user-OAuth flow (token used once,
// discarded); repo access uses short-lived installation tokens minted per
// request and never persisted.

import { createPrivateKey, createSign } from "node:crypto";
import { secretsGet } from "./aws.mjs";

const API = "https://api.github.com";
const UA = "memory-vault-hosted";

// The secret JSON is immutable once set — safe to cache across warm invocations.
let credsCache = null;
export async function appCreds() {
  if (!credsCache) {
    const raw = await secretsGet(process.env.MV_GITHUB_APP_SECRET_ARN);
    const c = JSON.parse(raw);
    for (const k of ["app_id", "client_id", "client_secret", "slug", "private_key"]) {
      if (!c[k] || c[k] === "REPLACE_ME") throw new Error(`github-app secret is missing ${k}`);
    }
    credsCache = { ...c, key: createPrivateKey(c.private_key) };
  }
  return credsCache;
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

export function appJwt(creds) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iat: now - 60, // absorb clock skew
    exp: now + 540,
    iss: creds.app_id,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(creds.key, "base64url");
  return `${unsigned}.${signature}`;
}

export async function ghApi(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": UA,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

// Exchange the user-OAuth code for the user's identity; the user token is
// used for exactly one /user call and discarded.
export async function exchangeUserCode(code) {
  const creds = await appCreds();
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ client_id: creds.client_id, client_secret: creds.client_secret, code }),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.access_token) throw new Error(`GitHub code exchange failed: ${out.error ?? res.status}`);
  const user = await ghApi("/user", { token: out.access_token });
  if (!user.ok) throw new Error(`GitHub /user failed: ${user.status}`);
  return { github_id: String(user.json.id), login: user.json.login };
}

// Verify an installation belongs to this GitHub user (the tenant wall at
// install time) and covers exactly one selected repo. Returns repo info.
export async function verifyInstallation(installationId, githubId) {
  const creds = await appCreds();
  const jwt = appJwt(creds);
  const inst = await ghApi(`/app/installations/${installationId}`, { token: jwt });
  if (!inst.ok) return { error: "installation not found — was the App uninstalled?" };
  if (String(inst.json.account?.id) !== String(githubId)) {
    return { error: "this installation belongs to a different GitHub account" };
  }
  if (inst.json.repository_selection !== "selected") {
    return { error: "the App must be installed on selected repositories, not all repositories" };
  }
  const { token } = await mintInstallationToken(installationId);
  const repos = await ghApi("/installation/repositories", { token });
  if (!repos.ok) return { error: `could not list installation repositories (${repos.status})` };
  const list = repos.json.repositories ?? [];
  if (list.length !== 1) {
    return { error: `the App must be installed on exactly one repository (found ${list.length})` };
  }
  const repo = list[0];
  if (repo.private !== true) return { error: `repository ${repo.full_name} is PUBLIC — memories require a private repo` };
  return { repo_full_name: repo.full_name, repo_id: String(repo.id), default_branch: repo.default_branch };
}

export async function mintInstallationToken(installationId) {
  const creds = await appCreds();
  const jwt = appJwt(creds);
  const res = await ghApi(`/app/installations/${installationId}/access_tokens`, { token: jwt, method: "POST" });
  if (res.status === 404) {
    const err = new Error("vault access was revoked — reinstall the GitHub App on your memories repository");
    err.revoked = true;
    throw err;
  }
  if (!res.ok) throw new Error(`installation token mint failed: ${res.status}`);
  return { token: res.json.token };
}
