/**
 * Cloudflare Pages _worker.js — proxy /p/* and /api/* to the Worker.
 * NOTE: This file is only used when deploying to Cloudflare Pages (e.g. filo-hub.pages.dev).
 * When deploying via `wrangler deploy` with [assets] (Workers Sites), this file is served as a static asset and not executed — the Worker in worker.js handles everything directly.
 */
const WORKER_HOST = "filo.ajax.workers.dev"; // must match your Workers subdomain — update if you change wrangler name or account

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const isProxyPath = url.pathname.startsWith("/p/") || url.pathname.startsWith("/api/");
    if (!isProxyPath) {
      return env.ASSETS.fetch(req);
    }

    const originalHost = url.host;
    const workerUrl = new URL(req.url);
    workerUrl.hostname = WORKER_HOST;
    workerUrl.protocol = "https:";

    const newReq = new Request(workerUrl, req);
    newReq.headers.set("x-forwarded-host", originalHost);
    newReq.headers.set("x-real-ip", req.headers.get("cf-connecting-ip") || "");

    let res;
    try {
      res = await fetch(newReq);
    } catch (e) {
      return new Response("Upstream worker unavailable: " + (e.message || ""), { status: 502, headers: { "Access-Control-Allow-Origin": req.headers.get("Origin") || "*" } });
    }

    // Rewrite upload response URL to use original host (pages.dev) instead of workers.dev
    const ct = res.headers.get("content-type") || "";
    if (url.pathname === "/api/upload" && ct.includes("application/json")) {
      const body = await res.text();
      try {
        const j = JSON.parse(body);
        if (j.url && typeof j.url === "string") {
          // Replace any workers.dev host with the original Pages host
          j.url = j.url.replace(WORKER_HOST, originalHost).replace("filo.dinesh-io.workers.dev", originalHost);
        }
        return new Response(JSON.stringify(j), {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": req.headers.get("Origin") || "*",
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      } catch {
        return new Response(body, { status: res.status, headers: res.headers });
      }
    }

    // Pass through other /api and /p responses, adding CORS
    const newHeaders = new Headers(res.headers);
    newHeaders.set("Access-Control-Allow-Origin", req.headers.get("Origin") || "*");
    newHeaders.set("Access-Control-Allow-Methods", "GET,HEAD,POST,DELETE,OPTIONS");
    newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
    newHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, ETag, Accept-Ranges");

    // Handle HEAD: strip body but keep headers
    if (req.method === "HEAD") {
      return new Response(null, { status: res.status, headers: newHeaders });
    }

    return new Response(res.body, { status: res.status, headers: newHeaders });
  }
}
