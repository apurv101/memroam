// Minimal AWS client for the hosted server: hand-rolled SigV4 over fetch,
// speaking to exactly two JSON/HTTP services — DynamoDB and Secrets Manager.
// Credentials come from the Lambda execution environment.

import { createHash, createHmac } from "node:crypto";

const REGION = process.env.AWS_REGION ?? "us-west-2";

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

function sigv4Headers({ service, host, target, body, contentType }) {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) throw new Error("missing AWS credentials in environment");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z"; // YYYYMMDDTHHMMSSZ
  const date = amzDate.slice(0, 8);

  const headers = {
    "content-type": contentType,
    host,
    "x-amz-date": amzDate,
    ...(target ? { "x-amz-target": target } : {}),
    ...(AWS_SESSION_TOKEN ? { "x-amz-security-token": AWS_SESSION_TOKEN } : {}),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256hex(body)].join("\n");
  const scope = `${date}/${REGION}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${AWS_SECRET_ACCESS_KEY}`, date), REGION), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host; // fetch sets it; it stays in the signature
  return headers;
}

async function awsCall({ service, prefix, target, params, contentType = "application/x-amz-json-1.0" }) {
  const host = `${prefix}.${REGION}.amazonaws.com`;
  const body = JSON.stringify(params);
  const headers = sigv4Headers({ service, host, target, body, contentType });
  const res = await fetch(`https://${host}/`, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) {
    let type = "";
    try {
      type = JSON.parse(text).__type ?? "";
    } catch {}
    const err = new Error(`${service} ${target} ${res.status}: ${type || text.slice(0, 200)}`);
    err.awsType = type;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

export const ddb = (action, params) =>
  awsCall({ service: "dynamodb", prefix: "dynamodb", target: `DynamoDB_20120810.${action}`, params });

export async function secretsGet(secretId) {
  const out = await awsCall({
    service: "secretsmanager",
    prefix: "secretsmanager",
    target: "secretsmanager.GetSecretValue",
    params: { SecretId: secretId },
    contentType: "application/x-amz-json-1.1",
  });
  return out.SecretString;
}

// ── DynamoDB attribute marshalling (only the shapes we store) ────────────────

export function marshall(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "number") out[k] = { N: String(v) };
    else if (typeof v === "boolean") out[k] = { BOOL: v };
    else if (Array.isArray(v)) out[k] = { L: v.map((x) => ({ S: String(x) })) };
    else out[k] = { S: String(v) };
  }
  return out;
}

export function unmarshall(item) {
  if (!item) return null;
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if ("S" in v) out[k] = v.S;
    else if ("N" in v) out[k] = Number(v.N);
    else if ("BOOL" in v) out[k] = v.BOOL;
    else if ("L" in v) out[k] = v.L.map((x) => x.S);
  }
  return out;
}
