// AUTO-GENERATED from worker.js — do not edit; regenerate with: npm run build
/**
 * filo — Cloudflare Worker (SINGLE SOURCE, two deploy targets)
 *
 * Workers: `wrangler deploy` — main = worker.js, [assets] = dist (wrangler.toml)
 * Pages:   public/_worker.js — AUTO-GENERATED from this file by the vite plugin
 *          in vite.config.js on every `npm run build`. Do not edit that copy.
 *
 * Bindings: BUCKET (R2), DB (D1). Optional secret UPLOAD_TOKEN:
 *   - unset  → open mode (single user, private URL) — current default
 *   - set    → POST /api/upload, DELETE /api/delete/*, GET /api/list and
 *              GET /api/storage require header `x-upload-token: <token>`
 *              (or `Authorization: Bearer <token>`). GET /p/<id> stays public.
 */

const ID_LEN = 8;
const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_SIZE = 25 * 1024 * 1024; // self-imposed limit (CF Workers allows up to 100MB)

// content-type map by extension (fallback when the browser sends no type)
const MIME_MAP = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", json: "application/json",
};

// Types the browser may render inline. SVG and HTML are deliberately excluded:
// served inline on our own origin they run script with dashboard access
// (stored XSS). Anything not listed is forced to download instead.
const INLINE_TYPES = new Set(["application/pdf", "text/plain", "text/csv", "application/json"]);
function isInlineType(type) {
  if (type === "image/svg+xml") return false;
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    INLINE_TYPES.has(type)
  );
}

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

// No CORS reflection: reflecting arbitrary Origins would let any website
// drive-by upload into R2 (or delete files) from visitors' browsers. Same-origin
// requests need no CORS headers; files stay embeddable cross-origin via
// <img>/<video>/direct links, which are not CORS-gated.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}

// constant-time-ish compare so tokens can't be guessed via timing
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req, env) {
  const want = env.UPLOAD_TOKEN;
  if (!want) return true; // open mode — no secret configured
  const auth = req.headers.get("Authorization") || "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-upload-token") || "";
  return safeEqual(got, want);
}

function sanitizeFilename(filename) {
  // Strip path, control chars, quotes; limit length; fallback to id
  let s = String(filename).split("/").pop().split("\\").pop();
  s = s.replace(/[\r\n"]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!s) s = "file";
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

function contentDisposition(filename, contentType) {
  const safe = sanitizeFilename(filename);
  const encoded = encodeURIComponent(safe).replace(/'/g, "%27");
  // Use both filename and filename* (RFC 5987) for UTF-8 support
  const fallback = safe.replace(/"/g, "_");
  const type = isInlineType(contentType) ? "inline" : "attachment";
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function autoFilename(originalName, titleInput, buf) {
  // try to infer title from file content if no title provided (simple text extract for txt/pdf)
  let base = (titleInput || "").trim();
  if (!base && buf) {
    try {
      const text = new TextDecoder().decode(buf.slice(0, 2000));
      // look for first meaningful line (alphanumeric)
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /[A-Za-z0-9]{3,}/.test(l));
      if (lines[0]) base = lines[0].slice(0, 10);
    } catch {}
  }
  if (!base) {
    const orig = (originalName || "file").replace(/\.[^/.]+$/, "");
    base = orig;
  }
  base = base.replace(/\s+/g, "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 10) || "file";
  const ext = extOf(originalName) || "bin";
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const check = nanoid(8);
  return `${base}${dd}${mm}${yyyy}${check}.${ext}`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight — no CORS headers granted, so cross-origin preflights
    // fail in the browser. Same-origin requests never preflight.
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    // Early check for missing bindings (nice error instead of raw exception)
    if (!env.BUCKET || !env.DB) {
      if (path.startsWith("/api/") || path.startsWith("/p/")) {
        return json({ error: "Server misconfigured: missing BUCKET or DB binding" }, 500);
      }
    }

    // Permanent file serving — public, immutable (any file type)
    if (path.startsWith("/p/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      const id = path.slice(3).split("/")[0].split(".")[0];
      if (!id || !/^[A-Za-z0-9]{6,12}$/.test(id)) {
        return new Response("Not found", { status: 404 });
      }
      // Try both new key (p/<id>) and legacy (p/<id>.pdf) for backward compat
      let obj = await env.BUCKET.get(`p/${id}`);
      let key = `p/${id}`;
      if (!obj) {
        obj = await env.BUCKET.get(`p/${id}.pdf`);
        key = `p/${id}.pdf`;
      }
      if (!obj) return new Response("File not found", { status: 404 });

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
      // SVG/HTML/unknown types download instead of rendering inline —
      // inline script in them would run on our origin (stored XSS).
      headers.set("Content-Disposition", contentDisposition(filename, contentType));
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cache-Control", "public, immutable, max-age=31536000");
      if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
      headers.set("Accept-Ranges", "bytes");

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

    // API: Health — public (uptime checks)
    if (path === "/api/health") {
      return json({ ok: true, time: Date.now() });
    }

    // Everything below is the private API — token-gated when UPLOAD_TOKEN is set.
    if (!authorized(req, env)) return json({ error: "Unauthorized" }, 401);

    // API: List
    if (path === "/api/list" && req.method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, filename, size, uploaded_at, title, category FROM docs ORDER BY uploaded_at DESC LIMIT 200"
        ).all();
        return json({ docs: results || [] });
      } catch (e) {
        console.error("list failed:", e);
        return json({ error: "Failed to list files" }, 500);
      }
    }

    // API: Upload
    if (path === "/api/upload" && req.method === "POST") {
      let form;
      try {
        form = await req.formData();
      } catch {
        return json({ error: "Invalid form data. Send multipart/form-data with 'file' field." }, 400);
      }

      const file = form.get("file");
      if (!file || typeof file === "string") {
        return json({ error: "No file uploaded. Field name must be 'file'." }, 400);
      }
      if (file.size === 0) return json({ error: "Empty file" }, 400);
      if (file.size > MAX_SIZE) return json({ error: `File too large. Max ${MAX_SIZE / 1024 / 1024}MB` }, 400);

      const buf = await file.arrayBuffer();
      const titleInput = (form.get("title") || "").toString().slice(0, 200);
      const category = (form.get("category") || "").toString().slice(0, 100);
      const filename = sanitizeFilename(autoFilename(file.name || "file", titleInput, buf));
      const contentType = guessContentType(filename, file.type);
      // Title keeps its spaces (shown in the dashboard); only the stored
      // filename is squished. No title → NULL, dashboard shows the filename.
      const title = titleInput.trim() || null;

      // Allocate the id by inserting FIRST — the row PK is the single source
      // of truth, so concurrent uploads can never race onto the same key
      // (the old check-then-put could delete the other upload's object on
      // rollback and leave an orphaned row).
      let id;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = nanoid();
        try {
          await env.DB.prepare(
            "INSERT INTO docs (id, filename, size, uploaded_at, title, category) VALUES (?, ?, ?, ?, ?, ?)"
          )
            .bind(candidate, filename, file.size, Date.now(), title, category || null)
            .run();
          id = candidate;
          break;
        } catch (e) {
          if (!/UNIQUE constraint failed/i.test(String(e.message || ""))) {
            console.error("insert failed:", e);
            return json({ error: "Failed to save file metadata" }, 500);
          }
          // id collision — astronomically rare, try the next candidate
        }
      }
      if (!id) return json({ error: "Failed to generate a unique id, try again" }, 500);

      const key = `p/${id}`;
      try {
        await env.BUCKET.put(key, buf, {
          httpMetadata: { contentType },
          customMetadata: { filename, uploadedAt: String(Date.now()) },
        });
      } catch (e) {
        // rollback the row so it doesn't point at a missing object
        console.error("r2 put failed:", e);
        await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run().catch(() => {});
        return json({ error: "Failed to store file" }, 500);
      }

      const base = `${url.protocol}//${getSafeHost(req, url)}`;
      return json({
        id,
        filename,
        size: file.size,
        url: `${base}/p/${id}`,
        message: "Uploaded. This URL is permanent.",
      });
    }

    // API: Delete — validate id to prevent injection
    if (path.startsWith("/api/delete/") && req.method === "DELETE") {
      const id = path.slice("/api/delete/".length).split("/")[0];
      if (!id || !/^[A-Za-z0-9]{6,12}$/.test(id)) return json({ error: "Invalid id" }, 400);
      await env.BUCKET.delete(`p/${id}`);
      await env.BUCKET.delete(`p/${id}.pdf`); // legacy cleanup
      await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run();
      return json({ ok: true, id });
    }

    // API: Storage — one indexed query, not a full R2 bucket scan
    // (objects placed in the bucket outside the app are not counted)
    if (path === "/api/storage" && req.method === "GET") {
      try {
        const row = await env.DB
          .prepare("SELECT COALESCE(SUM(size), 0) AS total, COUNT(*) AS count FROM docs")
          .first();
        return json({ total: row?.total || 0, count: row?.count || 0 });
      } catch (e) {
        console.error("storage failed:", e);
        return json({ error: "Failed to read storage stats" }, 500);
      }
    }

    // Fallback for unknown API routes
    if (path.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    // Static assets (Pages: _worker.js sees every request; Workers: requests
    // that didn't match an asset). env.ASSETS applies the SPA fallback.
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Not found", { status: 404 });
  },
};
