/**
 * filo - Cloudflare Worker (any file type)
 * Plug-and-play: upload -> permanent /p/<id> link
 * Bindings: BUCKET (R2), DB (D1)
 */
const ID_LEN = 8;
const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_SIZE = 25 * 1024 * 1024; // 25MB - Cloudflare free limit

// Basic content-type map by extension (fallback if browser sends empty type)
const MIME_MAP = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", json: "application/json",
};

// Host validation for x-forwarded-host (prevent header injection / XSS)
const SAFE_HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
function getSafeHost(req, url) {
  const forwarded = req.headers.get("x-forwarded-host");
  if (forwarded && SAFE_HOST_RE.test(forwarded) && forwarded.length <= 253 && !forwarded.includes("..")) {
    return forwarded;
  }
  return url.host;
}

function extOf(filename) {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}
function guessContentType(filename, provided) {
  if (provided && provided !== "application/octet-stream" && provided !== "") return provided;
  const ext = extOf(filename);
  return MIME_MAP[ext] || "application/octet-stream";
}

function nanoid(len = ID_LEN) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let id = "";
  for (let i = 0; i < len; i++) id += ID_CHARS[arr[i] % 62];
  return id;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, ETag, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function sanitizeFilename(filename) {
  // Strip path, control chars, quotes; limit length; fallback to id
  let s = String(filename).split("/").pop().split("\\").pop();
  s = s.replace(/[\r\n"]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!s) s = "file";
  // Limit to 200 chars to avoid header overflow
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

function contentDisposition(filename) {
  const safe = sanitizeFilename(filename);
  const encoded = encodeURIComponent(safe).replace(/'/g, "%27");
  // Use both filename and filename* (RFC 5987) for UTF-8 support
  // Escape quotes in fallback
  const fallback = safe.replace(/"/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    const path = url.pathname;

    // Early check for missing bindings (nice error instead of raw exception)
    if (!env.BUCKET || !env.DB) {
      if (path.startsWith("/api/") || path.startsWith("/p/")) {
        return json({ error: "Server misconfigured: missing BUCKET or DB binding" }, 500, origin);
      }
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Permanent file serving - public, immutable (any file type)
    if (path.startsWith("/p/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD", ...corsHeaders(origin) } });
      }
      const id = path.slice(3).split("/")[0].split(".")[0];
      if (!id || !/^[A-Za-z0-9]{6,12}$/.test(id)) {
        return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
      }
      // Try both new key (p/<id>) and legacy (p/<id>.pdf) for backward compat
      let obj = await env.BUCKET.get(`p/${id}`);
      let key = `p/${id}`;
      if (!obj) {
        obj = await env.BUCKET.get(`p/${id}.pdf`);
        key = `p/${id}.pdf`;
      }
      if (!obj) return new Response("File not found", { status: 404, headers: corsHeaders(origin) });

      // Get original filename and content-type from D1
      let filename = id;
      let contentType = null;
      try {
        const row = await env.DB.prepare("SELECT filename FROM docs WHERE id = ?").bind(id).first();
        if (row?.filename) filename = row.filename;
      } catch (_) {}
      // Prefer stored httpMetadata, fallback to filename guess
      contentType = obj.httpMetadata?.contentType || guessContentType(filename, "");

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      if (contentType) headers.set("Content-Type", contentType);
      headers.set("Content-Disposition", contentDisposition(filename));
      headers.set("Cache-Control", "public, immutable, max-age=31536000");
      if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
      headers.set("Accept-Ranges", "bytes");
      // CORS for file serving (allows cross-origin fetch / embed)
      for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);

      const range = req.headers.get("Range");
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : obj.size - 1;
          // Validate range
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= obj.size || end >= obj.size) {
            headers.set("Content-Range", `bytes */${obj.size}`);
            return new Response("Range Not Satisfiable", { status: 416, headers });
          }
          const sliced = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
          if (sliced) {
            headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
            headers.set("Content-Length", String(sliced.size));
            if (req.method === "HEAD") {
              return new Response(null, { status: 206, headers });
            }
            return new Response(sliced.body, { status: 206, headers });
          }
        }
      }

      headers.set("Content-Length", String(obj.size));
      if (req.method === "HEAD") {
        return new Response(null, { headers });
      }
      return new Response(obj.body, { headers });
    }

    // API: List - public
    if (path === "/api/list" && req.method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, filename, size, uploaded_at, title, category FROM docs ORDER BY uploaded_at DESC LIMIT 200"
        ).all();
        return json({ docs: results || [] }, 200, origin);
      } catch (e) {
        return json({ error: e.message }, 500, origin);
      }
    }

    // API: Upload - open (no auth)
    if (path === "/api/upload" && req.method === "POST") {
      let form;
      try {
        form = await req.formData();
      } catch {
        return json({ error: "Invalid form data. Send multipart/form-data with 'file' field." }, 400, origin);
      }

      const file = form.get("file");
      if (!file || typeof file === "string") {
        return json({ error: "No file uploaded. Field name must be 'file'." }, 400, origin);
      }

      if (file.size === 0) return json({ error: "Empty file" }, 400, origin);
      if (file.size > MAX_SIZE) return json({ error: `File too large. Max ${MAX_SIZE / 1024 / 1024}MB` }, 400, origin);

      const buf = await file.arrayBuffer();
      const filename = sanitizeFilename(file.name || "file");
      const contentType = guessContentType(filename, file.type);
      const title = (form.get("title") || "").toString().slice(0, 200);
      const category = (form.get("category") || "").toString().slice(0, 100);

      // Generate unique ID with collision check (extremely rare)
      let id;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = nanoid();
        const exists = await env.DB.prepare("SELECT id FROM docs WHERE id = ?").bind(candidate).first();
        if (!exists) {
          const r2exists = await env.BUCKET.head(`p/${candidate}`);
          const legacyExists = await env.BUCKET.head(`p/${candidate}.pdf`);
          if (!r2exists && !legacyExists) {
            id = candidate;
            break;
          }
        }
      }
      if (!id) return json({ error: "Failed to generate ID, try again" }, 500, origin);

      const key = `p/${id}`;
      await env.BUCKET.put(key, buf, {
        httpMetadata: { contentType },
        customMetadata: { filename, uploadedAt: String(Date.now()) },
      });

      try {
        await env.DB.prepare(
          "INSERT INTO docs (id, filename, size, uploaded_at, title, category) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(id, filename, file.size, Date.now(), title || null, category || null)
          .run();
      } catch (e) {
        // rollback R2 on DB failure
        await env.BUCKET.delete(key);
        return json({ error: "DB insert failed: " + e.message }, 500, origin);
      }

      const host = getSafeHost(req, url);
      const base = `${url.protocol}//${host}`;
      const permanentUrl = `${base}/p/${id}`;
      return json(
        {
          id,
          filename,
          size: file.size,
          url: permanentUrl,
          message: "Uploaded. This URL is permanent.",
        },
        200,
        origin
      );
    }

    // API: Delete - open (no auth) — validate id to prevent injection
    if (path.startsWith("/api/delete/") && req.method === "DELETE") {
      const id = path.slice("/api/delete/".length).split("/")[0];
      if (!id || !/^[A-Za-z0-9]{6,12}$/.test(id)) return json({ error: "Invalid id" }, 400, origin);
      await env.BUCKET.delete(`p/${id}`);
      await env.BUCKET.delete(`p/${id}.pdf`); // legacy cleanup
      await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run();
      return json({ ok: true, id }, 200, origin);
    }

    // API: Health
    if (path === "/api/health") {
      return json({ ok: true, time: Date.now() }, 200, origin);
    }

    // Fallback
    if (path.startsWith("/api/")) {
      return json({ error: "Not found" }, 404, origin);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  },
};
