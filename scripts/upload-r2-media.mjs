#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const mediaRoot = resolve(projectRoot, "public/wp-content/uploads");
const statePath = resolve(projectRoot, ".r2-upload-state.json");
const bucket = "jammindjs-atlanta";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "d72266023791a2e75c888b7a9c5867f1";
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const concurrency = Math.max(1, Math.min(8, Number(process.env.R2_UPLOAD_CONCURRENCY || 4)));

if (!accessKeyId || !secretAccessKey) {
  throw new Error(
    "Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY from a bucket-scoped Object Read & Write R2 token.",
  );
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && !path.includes(`${sep}cms${sep}`)) files.push(path);
  }
  return files;
}

async function fingerprint(path) {
  const info = await stat(path);
  const hash = createHash("sha256").update(await readFile(path)).digest("hex");
  return `${info.size}:${hash}`;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function upload(path, key, contentType) {
  const body = await readFile(path);
  const payloadHash = sha256(body);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${bucket}/${encodeKey(key)}`;
  const cacheControl = "public, max-age=31536000, immutable";
  const canonicalHeaders = [
    `cache-control:${cacheControl}`,
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const signedHeaders = "cache-control;content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${shortDate}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, shortDate);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}${canonicalUri}`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Cache-Control": cacheControl,
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Upload failed for ${key}: HTTP ${response.status} ${detail}`);
  }
}

const state = await loadState();
const files = await walk(mediaRoot);
const queue = [];

for (const path of files) {
  const key = relative(resolve(projectRoot, "public"), path).split(sep).join("/");
  const signature = await fingerprint(path);
  if (state[key] === signature) continue;
  queue.push({ path, key, signature });
}

console.log(`Uploading ${queue.length} of ${files.length} media objects to R2 (${concurrency} concurrent).`);
let cursor = 0;
let completed = 0;

async function worker() {
  while (cursor < queue.length) {
    const item = queue[cursor++];
    const contentType = mimeTypes[extname(item.path).toLowerCase()] || "application/octet-stream";
    await upload(item.path, item.key, contentType);
    state[item.key] = item.signature;
    completed += 1;
    if (completed % 10 === 0 || completed === queue.length) {
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      console.log(`${completed}/${queue.length} uploaded`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log("R2 media upload complete.");
