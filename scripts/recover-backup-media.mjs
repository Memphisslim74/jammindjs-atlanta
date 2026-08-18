#!/usr/bin/env node

import { access, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const backupUploads = path.resolve(process.argv[2] ?? "");
const publicRoot = path.resolve(process.argv[3] ?? "public");
const maxAssetBytes = 25 * 1024 * 1024;

if (!process.argv[2]) {
  throw new Error("Usage: node scripts/recover-backup-media.mjs <extracted-backup-uploads> [public-dir]");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(file)));
    else if (file.endsWith(".html")) files.push(file);
  }
  return files;
}

const references = new Set();
for (const file of await walk(publicRoot)) {
  const html = await readFile(file, "utf8");
  for (const match of html.matchAll(
    /(?:src|href|poster|data-src|data-lazy-src)=["']([^"']+)/gi,
  )) {
    try {
      const url = new URL(match[1], "https://www.jammindjs.net");
      if (
        ["www.jammindjs.net", "jammindjs.net"].includes(url.hostname) &&
        url.pathname.startsWith("/wp-content/uploads/")
      ) {
        references.add(decodeURIComponent(url.pathname));
      }
    } catch {
      // Ignore malformed legacy markup.
    }
  }
}

const oversized = [];
let recovered = 0;
for (const publicPath of references) {
  const destination = path.join(publicRoot, publicPath);
  if (await exists(destination)) continue;

  const sourceRelative = publicPath.replace(/^\/wp-content\/uploads\//, "");
  const source = path.join(backupUploads, sourceRelative);
  if (!(await exists(source))) continue;
  const details = await stat(source);
  if (details.size >= maxAssetBytes) {
    oversized.push({ publicPath, sourceRelative, originalBytes: details.size });
    continue;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  recovered += 1;
}

oversized.sort((left, right) => right.originalBytes - left.originalBytes);
await writeFile(
  path.resolve("content/oversized-media.json"),
  `${JSON.stringify({ maxAssetBytes, assets: oversized }, null, 2)}\n`,
);
console.log(`Recovered ${recovered} referenced media files from the WordPress backup.`);
console.log(`Identified ${oversized.length} oversized assets for optimization.`);
