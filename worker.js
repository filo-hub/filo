/**
 * filo - Cloudflare Worker (any file type)
 * Plug-and-play: upload -> permanent /p/<id> link
 * Bindings: BUCKET (R2), DB (D1), UPLOAD_TOKEN (secret)
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
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function unauthorized(origin) {
  return json({ error: "Unauthorized. Set Authorization: Bearer <UPLOAD_TOKEN>" }, 401, origin);
}

function isAuthorized(req, env) {
  const token = env.UPLOAD_TOKEN;
  if (!token) return true; // if not set, allow (dev mode) - set in prod!
  const hdr = req.headers.get("Authorization") || "";
  return hdr === `Bearer ${token}`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    const path = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Permanent file serving - public, immutable (any file type)
    if (path.startsWith("/p/")) {
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
      // Override with correct type if needed
      if (contentType) headers.set("Content-Type", contentType);
      // Inline for viewable types, attachment fallback for others handled by browser
      headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
      headers.set("Cache-Control", "public, immutable, max-age=31536000");
      headers.set("ETag", obj.httpEtag);
      headers.set("Accept-Ranges", "bytes");

      const range = req.headers.get("Range");
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : obj.size - 1;
          const sliced = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
          if (sliced) {
            headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
            headers.set("Content-Length", String(sliced.size));
            return new Response(sliced.body, { status: 206, headers });
          }
        }
      }

      headers.set("Content-Length", String(obj.size));
      return new Response(obj.body, { headers });
    }

    // API: List - public (or you can protect it - keep public for dashboard convenience)
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

    // API: Upload - protected
    if (path === "/api/upload" && req.method === "POST") {
      if (!isAuthorized(req, env)) return unauthorized(origin);

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

      // Validate any file
      if (file.size === 0) return json({ error: "Empty file" }, 400, origin);
      if (file.size > MAX_SIZE) return json({ error: `File too large. Max ${MAX_SIZE / 1024 / 1024}MB` }, 400, origin);

      const buf = await file.arrayBuffer();
      const filename = file.name || "file";
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

      const base = `${url.protocol}//${url.host}`;
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

    // API: Delete - protected
    if (path.startsWith("/api/delete/") && req.method === "DELETE") {
      if (!isAuthorized(req, env)) return unauthorized(origin);
      const id = path.slice("/api/delete/".length).split("/")[0];
      if (!id) return json({ error: "Missing id" }, 400, origin);
      await env.BUCKET.delete(`p/${id}`);
      await env.BUCKET.delete(`p/${id}.pdf`); // legacy cleanup
      await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run();
      return json({ ok: true, id }, 200, origin);
    }

    // API: Health
    if (path === "/api/health") {
      return json({ ok: true, time: Date.now() }, 200, origin);
    }

    // Fallback to static assets (public/index.html) - for Workers with assets binding
    // If using `assets` in wrangler.toml, this fetch will be intercepted before reaching here.
    // Return 404 for unknown API routes, let frontend handle others.
    if (path.startsWith("/api/")) {
      return json({ error: "Not found" }, 404, origin);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  },
};
