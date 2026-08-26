// The OAuth 2.1 authorization server (MCP auth spec 2025-06-18): metadata
// discovery, dynamic client registration (RFC 7591), authorization code +
// PKCE (S256 only), rotating refresh tokens. GitHub hosts every consent
// screen except our one approve/deny gate — which exists because DCR is open
// to the world, so a human must confirm which client gets access. No cookies
// anywhere; the one-time nonce on the consent form is the only browser state.

import { createHash, randomBytes } from "node:crypto";
import {
  deleteAuthreq,
  getAccessToken,
  getAuthreq,
  getClient,
  getRefreshToken,
  getUser,
  getUserByGithubId,
  mintTokenPair,
  putAuthreq,
  putClient,
  putCode,
  putUser,
  randToken,
  rotateRefreshToken,
  sha256,
  takeCode,
} from "./db.mjs";
import { appCreds, exchangeUserCode, ghApi, mintInstallationToken, verifyInstallation } from "./github-auth.mjs";
import { consentPage, errorPage, installProblemPage } from "./pages.mjs";
import { uuidv7 } from "../store.mjs";

const json = (status, obj, headers = {}) => ({
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  body: JSON.stringify(obj),
});
const html = (status, body) => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body });
const redirect = (to) => ({ status: 302, headers: { location: to }, body: "" });
const oauthError = (status, error, description) => json(status, { error, error_description: description });

// ── Metadata ─────────────────────────────────────────────────────────────────

export const protectedResourceMetadata = (base) =>
  json(200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["vault"],
  });

export const authorizationServerMetadata = (base) =>
  json(200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["vault"],
  });

// ── Dynamic client registration ──────────────────────────────────────────────

// https, loopback http, or a private-use scheme (RFC 8252 §7.1 — native apps
// like Cursor register e.g. cursor://…/callback). Only plain http to a
// non-loopback host is rejected.
const validRedirect = (u) => {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol !== "";
  } catch {
    return false;
  }
};

export async function register(body) {
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(validRedirect)) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must be https, loopback http, or private-scheme URLs");
  }
  const client = {
    client_id: randToken("mvc_", 16),
    client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "",
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    created_at: new Date().toISOString(),
  };
  await putClient(client);
  return json(201, { ...client, client_id_issued_at: Math.floor(Date.now() / 1000) });
}

// ── Authorization endpoint ───────────────────────────────────────────────────

export async function authorize(base, q) {
  const client = q.client_id ? await getClient(q.client_id) : null;
  // Invalid client/redirect renders — never redirects (open-redirect guard).
  if (!client) return html(400, errorPage("Unknown client", "The requesting application is not registered."));
  if (!client.redirect_uris.includes(q.redirect_uri)) {
    return html(400, errorPage("Invalid redirect", "The redirect URI does not match the client registration."));
  }
  const back = (error, description) =>
    redirect(`${q.redirect_uri}?${new URLSearchParams({ error, error_description: description, ...(q.state ? { state: q.state } : {}) })}`);
  if (q.response_type !== "code") return back("unsupported_response_type", "only response_type=code is supported");
  if (!q.code_challenge || q.code_challenge_method !== "S256") {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  // Lenient resource handling: validate when present, bind to our sole
  // resource regardless (connector implementations vary).
  if (q.resource && q.resource !== `${base}/mcp`) return back("invalid_target", "unknown resource");

  const id = randToken("", 24);
  await putAuthreq(id, {
    stage: "started",
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uri: q.redirect_uri,
    client_state: q.state ?? "",
    code_challenge: q.code_challenge,
    resource: `${base}/mcp`,
    default_space: "shared",
  });
  const creds = await appCreds();
  const to = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: `${base}/callback/github`,
    state: id,
  });
  return redirect(`https://github.com/login/oauth/authorize?${to}`);
}

// ── GitHub sign-in callback ──────────────────────────────────────────────────

async function renderConsent(authreqId, req, user) {
  const nonce = randToken("", 16);
  await putAuthreq(authreqId, { ...req, stage: "consent", user_id: user.user_id, nonce });
  return html(
    200,
    consentPage({
      clientName: req.client_name,
      repoFullName: user.repo_full_name,
      defaultSpace: req.default_space,
      authreqId,
      nonce,
    }),
  );
}

export async function githubCallback(base, q) {
  const req = q.state ? await getAuthreq(q.state) : null;
  if (!req) return html(400, errorPage("Session expired", "This sign-in link expired — restart the connection from your chat client."));
  if (!q.code) return html(400, errorPage("Sign-in failed", "GitHub did not return an authorization code."));
  let identity;
  try {
    identity = await exchangeUserCode(q.code);
  } catch (err) {
    return html(502, errorPage("Sign-in failed", err.message));
  }
  let user = await getUserByGithubId(identity.github_id);
  if (!user) {
    user = {
      user_id: `u_${uuidv7()}`,
      github_id: identity.github_id,
      github_login: identity.login,
      created_at: new Date().toISOString(),
    };
    await putUser(user);
  }
  if (user.installation_id) {
    // Returning user: confirm the installation is still alive and still theirs.
    const check = await verifyInstallation(user.installation_id, user.github_id);
    if (!check.error) {
      if (check.repo_id !== user.repo_id || check.repo_full_name !== user.repo_full_name) {
        user = { ...user, repo_full_name: check.repo_full_name, repo_id: check.repo_id };
        await putUser(user);
      }
      return renderConsent(q.state, req, user);
    }
    user = { ...user, installation_id: "", repo_full_name: "", repo_id: "" };
    await putUser(user);
  }
  // First-time (or broken) installation: GitHub's install picker is the repo
  // consent screen; state rides through to the Setup URL.
  await putAuthreq(q.state, { ...req, stage: "signed-in", user_id: user.user_id });
  const creds = await appCreds();
  return redirect(`https://github.com/apps/${creds.slug}/installations/new?state=${encodeURIComponent(q.state)}`);
}

// ── App install callback (Setup URL) ─────────────────────────────────────────

async function bootstrapIfEmpty(user) {
  const [owner, repo] = user.repo_full_name.split("/");
  const { token } = await mintInstallationToken(user.installation_id);
  const meta = await ghApi(`/repos/${owner}/${repo}`, { token });
  if (!meta.ok) return;
  const ref = await ghApi(`/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${meta.json.default_branch}`)}`, { token });
  if (ref.status !== 404 && ref.status !== 409) return; // repo already has commits
  await ghApi(`/repos/${owner}/${repo}/contents/${encodeURIComponent(".memroam")}`, {
    token,
    method: "PUT",
    body: {
      message: "memroam: initialize store",
      content: Buffer.from('{"format":1}\n').toString("base64"),
    },
  });
}

export async function installCallback(q) {
  const req = q.state ? await getAuthreq(q.state) : null;
  if (!req || req.stage !== "signed-in" || !req.user_id) {
    return html(400, errorPage("Session expired", "This install link expired — restart the connection from your chat client."));
  }
  const user = await getUser(req.user_id);
  if (!user) return html(400, errorPage("Session expired", "Restart the connection from your chat client."));
  const creds = await appCreds();
  if (!q.installation_id) return html(400, installProblemPage("No installation was completed.", creds.slug));
  const check = await verifyInstallation(q.installation_id, user.github_id);
  if (check.error) return html(400, installProblemPage(check.error, creds.slug));
  const updated = {
    ...user,
    installation_id: String(q.installation_id),
    repo_full_name: check.repo_full_name,
    repo_id: check.repo_id,
  };
  await putUser(updated);
  await bootstrapIfEmpty(updated).catch(() => {}); // best effort; store refuses cleanly if it failed
  return renderConsent(q.state, req, updated);
}

// ── Consent decision ─────────────────────────────────────────────────────────

export async function approve(form) {
  const req = form.authreq ? await getAuthreq(form.authreq) : null;
  if (!req || req.stage !== "consent" || !req.nonce || req.nonce !== form.nonce) {
    return html(400, errorPage("Session expired", "This approval form expired — restart the connection from your chat client."));
  }
  await deleteAuthreq(form.authreq); // single use, either way
  const params = req.client_state ? { state: req.client_state } : {};
  if (form.decision !== "approve") {
    return redirect(`${req.redirect_uri}?${new URLSearchParams({ error: "access_denied", ...params })}`);
  }
  const code = randToken("mvcode_");
  await putCode(code, {
    user_id: req.user_id,
    client_id: req.client_id,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    resource: req.resource,
    default_space: req.default_space,
  });
  return redirect(`${req.redirect_uri}?${new URLSearchParams({ code, ...params })}`);
}

// ── Token endpoint ───────────────────────────────────────────────────────────

export async function token(form) {
  if (form.grant_type === "authorization_code") {
    if (!form.code || !form.code_verifier) return oauthError(400, "invalid_request", "code and code_verifier are required");
    const item = await takeCode(form.code); // single use: deleted on read, replay finds nothing
    if (!item) return oauthError(400, "invalid_grant", "authorization code is invalid, expired, or already used");
    if (form.client_id !== item.client_id) return oauthError(400, "invalid_grant", "client mismatch");
    if (form.redirect_uri && form.redirect_uri !== item.redirect_uri) {
      return oauthError(400, "invalid_grant", "redirect_uri mismatch");
    }
    const challenge = createHash("sha256").update(form.code_verifier).digest("base64url");
    if (challenge !== item.code_challenge) return oauthError(400, "invalid_grant", "PKCE verification failed");
    const pair = await mintTokenPair(item);
    return json(200, {
      access_token: pair.access,
      token_type: "Bearer",
      expires_in: pair.expires_in,
      refresh_token: pair.refresh,
      scope: "vault",
    });
  }
  if (form.grant_type === "refresh_token") {
    if (!form.refresh_token) return oauthError(400, "invalid_request", "refresh_token is required");
    const item = await getRefreshToken(form.refresh_token);
    if (!item) return oauthError(400, "invalid_grant", "refresh token is invalid or expired");
    if (form.client_id && form.client_id !== item.client_id) return oauthError(400, "invalid_grant", "client mismatch");
    const pair = await rotateRefreshToken(item, sha256(form.refresh_token));
    return json(200, {
      access_token: pair.access,
      token_type: "Bearer",
      expires_in: pair.expires_in,
      refresh_token: pair.refresh,
      scope: "vault",
    });
  }
  return oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
}

// ── Bearer validation for /mcp ───────────────────────────────────────────────

export async function authenticateBearer(headers) {
  const auth = headers.authorization ?? headers.Authorization ?? "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) return { error: "missing bearer token" };
  const item = await getAccessToken(m[1]);
  if (!item) return { error: "invalid or expired token" };
  const user = await getUser(item.user_id);
  if (!user || !user.installation_id) return { error: "grant is no longer connected to a vault" };
  return { user: { ...user, default_space: item.default_space || "shared" } };
}
