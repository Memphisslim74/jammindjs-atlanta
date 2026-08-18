#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://www.jammindjs.net";
const CONTENT_ROOT = path.resolve("content");
const PER_PAGE = 100;

function decodeEntities(value = "") {
  return value
    .replaceAll("&#8217;", "’")
    .replaceAll("&#8216;", "‘")
    .replaceAll("&#8220;", "“")
    .replaceAll("&#8221;", "”")
    .replaceAll("&#038;", "&")
    .replaceAll("&amp;", "&")
    .replaceAll("&#039;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&hellip;", "…")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function localPath(link) {
  const url = new URL(link);
  return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
}

function imageFromEmbedded(entry) {
  return (
    entry._embedded?.["wp:featuredmedia"]?.[0]?.source_url ??
    entry.yoast_head_json?.og_image?.[0]?.url ??
    ""
  );
}

function authorFromEmbedded(entry) {
  return entry._embedded?.author?.[0]?.name ?? entry.yoast_head_json?.author ?? "";
}

function termsFromEmbedded(entry, taxonomy) {
  const groups = entry._embedded?.["wp:term"] ?? [];
  return groups
    .flat()
    .filter((term) => term.taxonomy === taxonomy)
    .map((term) => ({ name: term.name, slug: term.slug, link: term.link }));
}

async function fetchAll(type) {
  const records = [];
  let page = 1;
  while (true) {
    const url = new URL(`${ORIGIN}/wp-json/wp/v2/${type}`);
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("_embed", "1");
    const response = await fetch(url, {
      headers: { "user-agent": "JAMMIN-DJs-Cloudflare-Migration/1.0" },
    });
    if (!response.ok) throw new Error(`${type} page ${page}: HTTP ${response.status}`);
    records.push(...(await response.json()));
    const totalPages = Number(response.headers.get("x-wp-totalpages") ?? 1);
    if (page >= totalPages) break;
    page += 1;
  }
  return records;
}

async function exportType(type, folderName) {
  const records = await fetchAll(type);
  const folder = path.join(CONTENT_ROOT, folderName);
  await mkdir(folder, { recursive: true });

  for (const entry of records) {
    const seo = entry.yoast_head_json ?? {};
    const record = {
      source_id: entry.id,
      source_type: entry.type,
      managed: false,
      title: decodeEntities(entry.title?.rendered),
      slug: entry.slug,
      date: entry.date,
      modified: entry.modified,
      url: localPath(entry.link),
      status: entry.status,
      author: authorFromEmbedded(entry),
      excerpt: decodeEntities(entry.excerpt?.rendered),
      featured_image: imageFromEmbedded(entry),
      featured_image_alt:
        entry._embedded?.["wp:featuredmedia"]?.[0]?.alt_text ?? "",
      categories: termsFromEmbedded(entry, "category"),
      tags: termsFromEmbedded(entry, "post_tag"),
      category_name: termsFromEmbedded(entry, "category")[0]?.name ?? "Blog",
      category_url:
        termsFromEmbedded(entry, "category")[0]?.link ?? `${ORIGIN}/blog/`,
      seo_title: decodeEntities(seo.title),
      seo_description: decodeEntities(seo.description ?? seo.og_description),
      canonical: seo.canonical ?? entry.link,
      robots: seo.robots ?? { index: "index", follow: "follow" },
      body_html: entry.content?.rendered ?? "",
    };
    const file = path.join(folder, `${entry.id}-${entry.slug}.json`);
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  console.log(`Exported ${records.length} ${type} records.`);
  return records.length;
}

await mkdir(CONTENT_ROOT, { recursive: true });
const posts = await exportType("posts", "posts");
const pages = await exportType("pages", "pages");
await writeFile(
  path.join(CONTENT_ROOT, "export-summary.json"),
  `${JSON.stringify({ origin: ORIGIN, exportedAt: new Date().toISOString(), posts, pages }, null, 2)}\n`,
);
