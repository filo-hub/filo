export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/p/") || url.pathname.startsWith("/api/")) {
      const workerUrl = new URL(req.url);
      const originalHost = url.host;
      workerUrl.hostname = "filo.ajax.workers.dev";
      workerUrl.protocol = "https:";
      let newReq = new Request(workerUrl, req);
      // preserve original host for URL generation
      newReq.headers.set("x-forwarded-host", originalHost);
      newReq.headers.set("x-real-ip", req.headers.get("cf-connecting-ip") || "");
      let res = await fetch(newReq);
      // rewrite upload response URL to use original host (pages.dev)
      if (url.pathname === "/api/upload" && res.headers.get("content-type")?.includes("application/json")) {
        let body = await res.text();
        try {
          let j = JSON.parse(body);
          if (j.url) {
            j.url = j.url.replace("filo.dinesh-io.workers.dev", originalHost);
          }
          return new Response(JSON.stringify(j), { status: res.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": req.headers.get("Origin") || "*" } });
        } catch {}
        return new Response(body, res);
      }
      // for other /api and /p, just return
      // add CORS
      let newRes = new Response(res.body, res);
      newRes.headers.set("Access-Control-Allow-Origin", req.headers.get("Origin") || "*");
      return newRes;
    }
    return env.ASSETS.fetch(req);
  }
}
