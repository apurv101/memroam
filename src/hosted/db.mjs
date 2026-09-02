// Control-plane accessors over the three DynamoDB tables. Login bookkeeping
// only — never memories. Every secret stored here is a SHA-256 digest; a
// table dump yields nothing replayable. DynamoDB TTL is lazy GC, so expiry
// is always enforced here in code.

import { createHash, randomBytes } from "node:crypto";
import { ddb, marshall, unmarshall } from "./aws.mjs";

const USERS = process.env.MV_USERS_TABLE;
const CLIENTS = process.env.MV_OAUTH_CLIENTS_TABLE;
const GRANTS = process.env.MV_GRANTS_TABLE;

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const randToken = (prefix, bytes = 32) => `${prefix}${randomBytes(bytes).toString("base64url")}`;
const nowSec = () => Math.floor(Date.now() / 1000);

// ── users ─────────────────────────────────────────────────────────────────────

export async function getUser(userId) {
  const out = await ddb("GetItem", { TableName: USERS, Key: marshall({ user_id: userId }) });
  return unmarshall(out.Item);
}

export async function getUserByGithubId(githubId) {
  const out = await ddb("Query", {
    TableName: USERS,
    IndexName: "by-github-id",
    KeyConditionExpression: "github_id = :g",
    ExpressionAttributeValues: marshall({ ":g": String(githubId) }),
    Limit: 1,
  });
  return out.Items?.length ? unmarshall(out.Items[0]) : null;
}

export async function putUser(user) {
  await ddb("PutItem", { TableName: USERS, Item: marshall({ ...user, updated_at: new Date().toISOString() }) });
  return user;
}

// ── oauth clients ─────────────────────────────────────────────────────────────

export async function getClient(clientId) {
  const out = await ddb("GetItem", { TableName: CLIENTS, Key: marshall({ client_id: clientId }) });
  return unmarshall(out.Item);
}

export async function putClient(client) {
  await ddb("PutItem", { TableName: CLIENTS, Item: marshall(client) });
  return client;
}

// ── grants (authreq# / code# / at# / rt# items, TTL on expires_at) ────────────

async function getGrant(grantId) {
  const out = await ddb("GetItem", { TableName: GRANTS, Key: marshall({ grant_id: grantId }) });
  const item = unmarshall(out.Item);
  if (!item) return null;
  if (typeof item.expires_at === "number" && item.expires_at <= nowSec()) return null; // TTL is lazy
  return item;
}

export async function putGrant(grantId, attrs, ttlSeconds) {
  await ddb("PutItem", {
    TableName: GRANTS,
    Item: marshall({ grant_id: grantId, ...attrs, expires_at: nowSec() + ttlSeconds }),
  });
}

export async function deleteGrant(grantId) {
  await ddb("DeleteItem", { TableName: GRANTS, Key: marshall({ grant_id: grantId }) });
}

// Delete-and-return: used for single-use codes so a replay finds nothing.
export async function takeGrant(grantId) {
  const out = await ddb("DeleteItem", {
    TableName: GRANTS,
    Key: marshall({ grant_id: grantId }),
    ReturnValues: "ALL_OLD",
  });
  const item = unmarshall(out.Attributes);
  if (!item) return null;
  if (typeof item.expires_at === "number" && item.expires_at <= nowSec()) return null;
  return item;
}

export const getAuthreq = (id) => getGrant(`authreq#${id}`);
export const putAuthreq = (id, attrs) => putGrant(`authreq#${id}`, attrs, 600);
export const deleteAuthreq = (id) => deleteGrant(`authreq#${id}`);

export const takeCode = (code) => takeGrant(`code#${sha256(code)}`);
export const putCode = (code, attrs) => putGrant(`code#${sha256(code)}`, attrs, 60);

export const getAccessToken = (token) => getGrant(`at#${sha256(token)}`);
export const getRefreshToken = (token) => getGrant(`rt#${sha256(token)}`);

const AT_TTL = 2 * 60 * 60;
const RT_TTL = 30 * 24 * 60 * 60;

// Mint an access+refresh pair, cross-referenced by hash for cleanup.
export async function mintTokenPair({ user_id, client_id, resource, default_space }) {
  const access = randToken("mv_at_");
  const refresh = randToken("mv_rt_");
  const base = { user_id, client_id, resource, scope: "vault", default_space, created_at: new Date().toISOString() };
  await putGrant(`at#${sha256(access)}`, { ...base, refresh_hash: sha256(refresh) }, AT_TTL);
  await putGrant(`rt#${sha256(refresh)}`, { ...base, access_hash: sha256(access) }, RT_TTL);
  return { access, refresh, expires_in: AT_TTL };
}

export async function rotateRefreshToken(oldItem, oldTokenHash) {
  await deleteGrant(`rt#${oldTokenHash}`);
  if (oldItem.access_hash) await deleteGrant(`at#${oldItem.access_hash}`);
  return mintTokenPair(oldItem);
}
