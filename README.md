# JAMMIN' DJs Atlanta

Static Cloudflare migration of [jammindjs.net](https://www.jammindjs.net/). The
goal is visual and SEO parity with the existing WordPress site—not a redesign.

## What is preserved

- The original HTML structure, responsive layouts, fonts, colors, images,
  menus, scripts, embedded media, and external form destinations.
- Existing page and post paths, titles, descriptions, canonical tags, Open
  Graph metadata, schema markup, sitemaps, robots.txt, and the current 404 page.
- 98 WordPress pages and 298 WordPress posts as editable reference data under
  `content/`, plus every publicly indexed archive captured by the WordPress
  sitemap.
- Referenced media recovered from the supplied `.wpress` backup. The historical
  media library is stored in the existing `jammindjs-atlanta` R2 bucket and is
  served through its original `/wp-content/uploads/...` URLs.

WordPress, PHP, MySQL, Beaver Builder, and the plugin runtime are not deployed.
Only the rendered site and the assets it actually uses are shipped.

## Content editing

The repository includes `.pages.yml` for [Pages CMS](https://pagescms.org/).
After connecting the GitHub repository in Pages CMS:

- **Blog Posts** provides structured title, URL, date, featured image, SEO, and
  rich-text fields. Imported posts are retained for reference with `managed`
  disabled. Turn it on when intentionally moving an existing post to the CMS.
  New posts should keep `managed` enabled and use `publish` when ready.
- **Primary Page HTML** provides code editors for the main site pages. Editing
  these files preserves the exact legacy markup and layout.
- New Pages CMS media uploads go to `public/wp-content/uploads/cms`. Historical
  media remains in R2, while new, small editorial uploads can stay in Git.

The static content build uses `content/templates/blog-post.html` to give new
posts the same header, footer, typography, sharing controls, and visual style as
the existing blog.

## Commands

```bash
npm run dev
npm test
npm run build
```

Migration/source maintenance commands:

```bash
npm run mirror:wordpress
npm run content:export
npm run content:prepare-template
npm run content:build
npm run media:recover -- /path/to/extracted-backup/uploads public
scripts/optimize-large-media.sh /path/to/extracted-backup/uploads
npm run media:upload:r2
```

The `.wpress` file is an All-in-One WP Migration binary archive, not an XML
export. It is intentionally excluded from the repository. The migration scripts
can use an extracted backup to recover media that is referenced by the rendered
site but no longer downloadable from WordPress.

## Cloudflare deployment

This project deploys as a Cloudflare Worker with static assets and an R2
binding. The Worker intercepts only `/wp-content/uploads/*`; all page, SEO, and
archive URLs remain unchanged.

Before the first deployment, create a bucket-scoped R2 token with **Object Read
& Write** access to `jammindjs-atlanta`. Set its S3 credentials in the local
shell (never commit them), then run:

```bash
export R2_ACCESS_KEY_ID="..."
export R2_SECRET_ACCESS_KEY="..."
npm run media:upload:r2
npm run deploy:cloudflare
```

The media uploader is resumable. It records completed object fingerprints in
the ignored `.r2-upload-state.json` file and can safely be run again.

For Cloudflare Git integration use:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Node.js: 22 or newer

`wrangler.jsonc` binds `MEDIA` to the existing R2 bucket. The included
`404.html`, `_redirects`, and `_headers` files preserve the current not-found
behavior, external contact redirect, and safe baseline headers.
