import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const publicRoot = path.join(projectRoot, "public");

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
    else files.push(file);
  }
  return files;
}

test("the mirrored homepage preserves its design and SEO shell", async () => {
  const html = await readFile(path.join(publicRoot, "index.html"), "utf8");
  assert.match(html, /Atlanta DJ Service \| Wedding DJ/i);
  assert.match(html, /High-Energy Entertainment Across Georgia/i);
  assert.match(html, /jdj-site-3d-logo\.png/i);
  assert.match(html, /menu-main-navigation/i);
  assert.match(html, /rel=["']canonical["']/i);
  assert.match(html, /application\/ld\+json/i);
  assert.match(html, /jdjclients\.com/i);
});

test("all imported public posts and pages retain a deployable path", async () => {
  for (const type of ["posts", "pages"]) {
    const folder = path.join(projectRoot, "content", type);
    for (const file of await readdir(folder)) {
      if (!file.endsWith(".json")) continue;
      const record = JSON.parse(await readFile(path.join(folder, file), "utf8"));
      if (record.url === "/contact-us/") continue;
      const decodedUrl = decodeURIComponent(record.url);
      const output = path.join(publicRoot, decodedUrl, "index.html");
      assert.equal(await exists(output), true, `${type}/${file} is missing ${output}`);
    }
  }
});

test("the static artifact stays within Cloudflare Pages asset limits", async () => {
  const files = await walk(publicRoot);
  assert.ok(files.length < 20_000, `Expected fewer than 20,000 files, found ${files.length}`);
  let largest = { file: "", size: 0 };
  for (const file of files) {
    const details = await stat(file);
    if (details.size > largest.size) largest = { file, size: details.size };
  }
  assert.ok(
    largest.size < 25 * 1024 * 1024,
    `Asset exceeds 25 MiB: ${largest.file} (${largest.size} bytes)`,
  );
});

test("historical WordPress media is routed through the existing R2 bucket", async () => {
  const wrangler = await readFile(path.join(projectRoot, "wrangler.jsonc"), "utf8");
  const worker = await readFile(path.join(projectRoot, "worker/index.ts"), "utf8");
  const pages = await readFile(path.join(projectRoot, ".pages.yml"), "utf8");

  assert.match(wrangler, /"binding": "MEDIA"/);
  assert.match(wrangler, /"bucket_name": "jammindjs-atlanta"/);
  assert.match(wrangler, /"run_worker_first": \["\/wp-content\/uploads\/\*"\]/);
  assert.match(worker, /env\.MEDIA\.get/);
  assert.match(worker, /env\.ASSETS\.fetch\(request\)/);
  assert.match(pages, /public\/wp-content\/uploads\/cms/);
});

test("the CMS can generate a new post with the legacy visual shell", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "jammindjs-cms-test-"));
  const posts = path.join(temporary, "posts");
  const output = path.join(temporary, "public");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(posts, { recursive: true }), mkdir(output, { recursive: true })]),
  );

  const fixture = {
    managed: true,
    status: "publish",
    title: "CMS Migration Test",
    slug: "cms-migration-test",
    date: "2026-08-18T12:00:00",
    modified: "2026-08-18T12:00:00",
    url: "/blog/cms-migration-test/",
    author: "Jammin Blogger",
    excerpt: "CMS-generated post verification.",
    featured_image: "/wp-content/uploads/2020/10/jdj-logo-5f7c9c05669cd.jpg",
    featured_image_alt: "JAMMIN' DJs",
    category_name: "Blog",
    category_url: "/blog/",
    seo_title: "CMS Migration Test - JAMMIN' DJs",
    seo_description: "CMS-generated post verification.",
    canonical: "https://www.jammindjs.net/blog/cms-migration-test/",
    body_html: "<p>CMS build verification.</p>",
  };
  await writeFile(path.join(posts, "test.json"), `${JSON.stringify(fixture)}\n`);

  const result = spawnSync("node", ["scripts/build-managed-content.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CONTENT_POSTS_DIR: posts,
      PUBLIC_ROOT: output,
      BLOG_TEMPLATE_FILE: path.join(projectRoot, "content/templates/blog-post.html"),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = await readFile(
    path.join(output, "blog/cms-migration-test/index.html"),
    "utf8",
  );
  assert.match(html, /CMS Migration Test/);
  assert.match(html, /CMS build verification/);
  assert.match(html, /rel="canonical"/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
});
