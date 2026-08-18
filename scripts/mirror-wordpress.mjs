#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://www.jammindjs.net";
const OUTPUT_DIR = path.resolve(process.argv[2] ?? "public");
const CONCURRENCY = Number(process.env.MIRROR_CONCURRENCY ?? 12);
const USER_AGENT =
  "Mozilla/5.0 (compatible; JAMMIN-DJs-Cloudflare-Migration/1.0; +https://www.jammindjs.net/)";

const requested = new Set();
const downloaded = new Set();
const failures = [];
const pageUrls = new Set();
const assetUrls = new Set();

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"');
}

function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/gis)].map((match) =>
    decodeXml(match[1].trim()),
  );
}

function normalizeUrl(raw, base = ORIGIN) {
  if (!raw) return null;
  const value = raw.trim().replace(/^['"]|['"]$/g, "");
  if (
    !value ||
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.startsWith("javascript:") ||
    value.startsWith("#")
  ) {
    return null;
  }

  try {
    const url = new URL(value, base);
    url.hash = "";
    if (!["www.jammindjs.net", "jammindjs.net"].includes(url.hostname)) return null;
    url.protocol = "https:";
    url.host = "www.jammindjs.net";
    return url.href;
  } catch {
    return null;
  }
}

function outputPath(url, contentType = "") {
  const parsed = new URL(url);
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";

  const basename = path.posix.basename(pathname);
  if (!path.posix.extname(basename) && contentType.includes("text/html")) {
    pathname += "/index.html";
  }

  const safe = pathname
    .split("/")
    .map((segment) => segment.replace(/[<>:"|?*]/g, "_"))
    .join("/");
  return path.join(OUTPUT_DIR, safe);
}

function extractHtmlAssets(html, pageUrl) {
  const found = new Set();
  const attributePattern =
    /(?:src|href|poster|data-src|data-lazy-src|data-original|data-bg|data-background|data-background-image)\s*=\s*["']([^"']+)["']/gi;
  const srcsetPattern = /(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;
  const cssUrlPattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

  for (const match of html.matchAll(attributePattern)) {
    const normalized = normalizeUrl(match[1], pageUrl);
    if (normalized) found.add(normalized);
  }
  for (const match of html.matchAll(srcsetPattern)) {
    for (const candidate of match[1].split(",")) {
      const normalized = normalizeUrl(candidate.trim().split(/\s+/)[0], pageUrl);
      if (normalized) found.add(normalized);
    }
  }
  for (const match of html.matchAll(cssUrlPattern)) {
    const normalized = normalizeUrl(match[1], pageUrl);
    if (normalized) found.add(normalized);
  }

  return found;
}

function extractCssAssets(css, cssUrl) {
  const found = new Set();
  for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const normalized = normalizeUrl(match[1], cssUrl);
    if (normalized) found.add(normalized);
  }
  for (const match of css.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) {
    const normalized = normalizeUrl(match[1], cssUrl);
    if (normalized) found.add(normalized);
  }
  return found;
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "*/*" },
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
  }
  throw lastError;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function pool(items, worker) {
  const queue = [...items];
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });
  await Promise.all(runners);
}

async function discoverSitemaps() {
  const seen = new Set();
  const queue = [`${ORIGIN}/wp-sitemap.xml`];

  while (queue.length) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);

    const response = await fetchWithRetry(sitemapUrl);
    const xml = await response.text();
    const locations = sitemapLocations(xml);
    for (const location of locations) {
      if (location.endsWith(".xml")) queue.push(location);
      else pageUrls.add(location);
    }

    const file = outputPath(sitemapUrl, "application/xml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, xml);
  }

  pageUrls.add(`${ORIGIN}/`);
  for (const pathName of ["/robots.txt", "/favicon.ico"]) {
    assetUrls.add(`${ORIGIN}${pathName}`);
  }
}

async function downloadPage(url) {
  if (requested.has(url)) return;
  requested.add(url);
  try {
    const existingFile = outputPath(url, "text/html");
    if (await exists(existingFile)) {
      const html = await readFile(existingFile, "utf8");
      downloaded.add(url);
      for (const found of extractHtmlAssets(html, url)) assetUrls.add(found);
      return;
    }
    const response = await fetchWithRetry(url);
    const contentType = response.headers.get("content-type") ?? "";
    const body = Buffer.from(await response.arrayBuffer());
    const file = outputPath(url, contentType);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    downloaded.add(url);

    if (contentType.includes("text/html")) {
      const html = body.toString("utf8");
      for (const found of extractHtmlAssets(html, url)) assetUrls.add(found);
    }
  } catch (error) {
    failures.push({ url, error: String(error) });
  }
}

async function downloadAsset(url) {
  if (requested.has(url)) return;
  requested.add(url);
  try {
    const existingFile = outputPath(url);
    if (await exists(existingFile)) {
      downloaded.add(url);
      if (url.split("?")[0].endsWith(".css")) {
        const css = await readFile(existingFile, "utf8");
        for (const found of extractCssAssets(css, url)) assetUrls.add(found);
      }
      return;
    }
    const response = await fetchWithRetry(url);
    const contentType = response.headers.get("content-type") ?? "";
    const body = Buffer.from(await response.arrayBuffer());
    const file = outputPath(url, contentType);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    downloaded.add(url);

    if (contentType.includes("text/css") || url.split("?")[0].endsWith(".css")) {
      const css = body.toString("utf8");
      for (const found of extractCssAssets(css, url)) assetUrls.add(found);
    }
  } catch (error) {
    failures.push({ url, error: String(error) });
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await discoverSitemaps();
  console.log(`Discovered ${pageUrls.size} indexed URLs.`);

  await pool([...pageUrls], downloadPage);
  console.log(`Downloaded pages; discovered ${assetUrls.size} first-pass assets.`);

  let previousSize = -1;
  while (assetUrls.size !== previousSize) {
    previousSize = assetUrls.size;
    const remaining = [...assetUrls].filter((url) => !requested.has(url));
    if (!remaining.length) break;
    await pool(remaining, downloadAsset);
    console.log(`Downloaded ${downloaded.size} resources; ${assetUrls.size} assets known.`);
  }

  const report = {
    origin: ORIGIN,
    generatedAt: new Date().toISOString(),
    pages: pageUrls.size,
    assets: assetUrls.size,
    downloaded: downloaded.size,
    failures,
  };
  await writeFile(
    path.join(OUTPUT_DIR, "mirror-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));

  if (failures.length) process.exitCode = 2;
}

await main();
