/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const MEDIA_PREFIX = "/wp-content/uploads/";
const MEDIA_IMPORT_ROUTE = "/__r2-import-8d5e4c2a7f19";
const MEDIA_IMPORT_MANIFEST = "/_media-import-manifest.json";
const WORDPRESS_ORIGIN = "https://www.jammindjs.net";

function mediaImporterPage(): Response {
  const route = JSON.stringify(MEDIA_IMPORT_ROUTE);
  return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><title>JAMMIN' DJs media import</title>
<style>body{font:16px system-ui;max-width:760px;margin:48px auto;padding:0 20px}progress{width:100%;height:28px}pre{white-space:pre-wrap}</style></head>
<body><h1>R2 media import</h1><p>Keep this tab open until it says complete.</p>
<progress id="progress" value="0" max="1"></progress><pre id="status">Starting…</pre>
<script>
const route=${route}; let offset=0, total=1, imported=0, skipped=0, failed=0;
const status=document.querySelector('#status'), progress=document.querySelector('#progress');
async function run(){
  try {
    const response=await fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({offset,limit:8})});
    if(!response.ok) throw new Error(await response.text());
    const result=await response.json(); total=result.total; offset=result.next;
    imported+=result.imported; skipped+=result.skipped; failed+=result.failed;
    progress.max=total; progress.value=offset;
    status.textContent=offset+' / '+total+'\\nImported: '+imported+'\\nAlready present: '+skipped+'\\nFailed: '+failed;
    if(result.errors && result.errors.length){ status.textContent+='\\n\\nPAUSED:\\n'+result.errors.join('\\n'); return; }
    if(offset<total) setTimeout(run,150); else status.textContent+='\\n\\nCOMPLETE — send this result back to ChatGPT.';
  } catch(error) { status.textContent='Retrying after error: '+error; setTimeout(run,2000); }
}
run();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function importMediaBatch(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") return mediaImporterPage();
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
  const payload = await request.json<{ offset?: number; limit?: number }>().catch(() => ({}));
  const offset = Math.max(0, Number(payload.offset) || 0);
  const limit = Math.min(8, Math.max(1, Number(payload.limit) || 8));
  const manifestResponse = await env.ASSETS.fetch(new Request(new URL(MEDIA_IMPORT_MANIFEST, request.url)));
  if (!manifestResponse.ok) return new Response("Media manifest unavailable", { status: 500 });
  const paths = await manifestResponse.json<string[]>();
  const batch = paths.slice(offset, offset + limit);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  await Promise.all(batch.map(async (mediaPath) => {
    try {
      const sourceUrl = new URL(mediaPath, WORDPRESS_ORIGIN);
      const key = decodeURIComponent(sourceUrl.pathname.slice(1));
      if (await env.MEDIA.head(key)) { skipped += 1; return; }

      const source = await fetch(sourceUrl, { headers: { "user-agent": "JAMMIN-DJs-R2-Migration/1.0" } });
      if (!source.ok || !source.body) {
        throw new Error("origin returned " + source.status);
      }

      await env.MEDIA.put(key, source.body, {
        httpMetadata: {
          contentType: source.headers.get("content-type") || undefined,
          cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: { source: sourceUrl.href },
      });
      imported += 1;
    } catch (error) {
      failed += 1;
      errors.push(mediaPath + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }));

  return Response.json({
    total: paths.length,
    next: Math.min(paths.length, offset + batch.length),
    imported,
    skipped,
    failed,
    errors,
  }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

async function serveMedia(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.slice(1));
  const object =
    request.method === "HEAD"
      ? await env.MEDIA.head(key)
      : await env.MEDIA.get(key, {
          onlyIf: request.headers,
          range: request.headers,
        });

  // New CMS uploads may still be committed as static assets. R2 owns the
  // historical library; ASSETS is the intentional fallback for those files.
  if (object === null) {
    return env.ASSETS.fetch(request);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");

  if (request.method === "HEAD") {
    headers.set("content-length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  if (!("body" in object)) {
    return new Response(null, { status: 412, headers });
  }

  return new Response(object.body, {
    status: request.headers.has("range") ? 206 : 200,
    headers,
  });
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === MEDIA_IMPORT_ROUTE) {
      return importMediaBatch(request, env);
    }

    if (url.pathname.startsWith(MEDIA_PREFIX)) {
      return serveMedia(request, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
