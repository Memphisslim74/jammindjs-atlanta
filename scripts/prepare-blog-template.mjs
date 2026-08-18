#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://www.jammindjs.net";
const postsDirectory = path.resolve("content/posts");
const templateFile = path.resolve("content/templates/blog-post.html");

function replaceAll(source, value, token) {
  return value ? source.split(value).join(token) : source;
}

function displayDate(value) {
  const calendarDate = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(calendarDate);
}

const files = (await readdir(postsDirectory)).filter((file) => file.endsWith(".json"));
const posts = await Promise.all(
  files.map(async (file) => JSON.parse(await readFile(path.join(postsDirectory, file), "utf8"))),
);
posts.sort((left, right) => right.date.localeCompare(left.date));

const source = posts.find((post) => post.status === "publish");
if (!source) throw new Error("No published WordPress post was available for the blog template.");

const sourceFile = path.join("public", source.url, "index.html");
let html = await readFile(sourceFile, "utf8");
const body = source.body_html.trim();
if (!html.includes(body)) {
  throw new Error(`The rendered post body was not found in ${sourceFile}.`);
}

html = html.replace(body, "{{BODY_HTML}}");
html = html.replace(
  /<!-- This site is optimized with the Yoast SEO[\s\S]*?<!-- \/ Yoast SEO[^>]*-->/,
  "{{SEO_HEAD}}",
);

const absoluteUrl = `${ORIGIN}${source.url}`;
html = replaceAll(html, encodeURIComponent(absoluteUrl), "{{ABSOLUTE_URL_ENCODED}}");
html = replaceAll(html, absoluteUrl, "{{ABSOLUTE_URL}}");
html = replaceAll(html, encodeURIComponent(source.canonical), "{{CANONICAL_ENCODED}}");
html = replaceAll(html, source.canonical, "{{CANONICAL}}");
html = replaceAll(html, encodeURIComponent(source.title), "{{TITLE_URLENCODED}}");
html = replaceAll(html, source.title, "{{TITLE_HTML}}");
html = replaceAll(html, displayDate(source.date), "{{DISPLAY_DATE}}");
html = replaceAll(
  html,
  encodeURIComponent(source.featured_image),
  "{{FEATURED_IMAGE_ENCODED}}",
);
html = replaceAll(html, source.featured_image, "{{FEATURED_IMAGE}}");
html = replaceAll(html, source.featured_image_alt, "{{FEATURED_IMAGE_ALT}}");
html = replaceAll(html, source.category_url, "{{CATEGORY_URL}}");
html = replaceAll(html, source.category_name, "{{CATEGORY_NAME}}");

await mkdir(path.dirname(templateFile), { recursive: true });
await writeFile(templateFile, html);
console.log(`Prepared ${templateFile} from ${sourceFile}.`);
