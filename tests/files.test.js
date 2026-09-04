// Tests for /p/:id serving: headers, content-disposition XSS policy,
// full Range support (bounded, open, suffix), 416s, HEAD, delete flow.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

const fetch = (...args) => SELF.fetch(...args);

const BODY = "0123456789abcdefg"; // 17 bytes

async function resetAndUpload(content = BODY, name = "doc.txt", type = "text/plain") {
  await env.DB.prepare("DELETE FROM docs").run();
  await env.DB.prepare("DELETE FROM actions").run();
  const fd = new FormData();
  fd.append("file", new File([content], name, { type }));
  const r = await fetch("https://example.com/api/upload", { method: "POST", body: fd });
  return (await r.json()).id;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM docs").run();
  await env.DB.prepare("DELETE FROM actions").run();
});

describe("GET /p/:id", () => {
  it("serves the exact bytes with immutable caching and nosniff", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/p/${id}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(BODY);
    expect(r.headers.get("Cache-Control")).toBe("public, immutable, max-age=31536000");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Content-Type")).toBe("text/plain");
    expect(r.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it("serves SVG as attachment — never inline (stored XSS)", async () => {
    const id = await resetAndUpload('<svg onload="alert(1)"></svg>', "evil.svg", "image/svg+xml");
    const r = await fetch(`https://example.com/p/${id}`);
    expect(r.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(r.headers.get("Content-Disposition")).toMatch(/^attachment/);
    await r.text();
  });

  it("serves images/pdf/text inline", async () => {
    const id = await resetAndUpload("x".repeat(8), "pic.png", "image/png");
    const r = await fetch(`https://example.com/p/${id}`);
    expect(r.headers.get("Content-Disposition")).toMatch(/^inline/);
    await r.text();
  });

  it("404s unknown ids and rejects malformed ones", async () => {
    expect((await fetch("https://example.com/p/zzzzzzzz")).status).toBe(404);
    expect((await fetch("https://example.com/p/../../etc/passwd")).status).toBe(404);
    expect((await fetch("https://example.com/p/short")).status).toBe(404);
  });

  it("405s non-GET/HEAD methods", async () => {
    const r = await fetch("https://example.com/p/zzzzzzzz", { method: "POST" });
    expect(r.status).toBe(405);
    await r.text();
  });

  it("HEAD returns headers without a body", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/p/${id}`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Length")).toBe(String(BODY.length));
    expect(r.body).toBe(null);
  });
});

describe("Range requests", () => {
  it("bounded: bytes=2-9 returns a 206 with the right slice", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/p/${id}`, { headers: { Range: "bytes=2-9" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe(`bytes 2-9/${BODY.length}`);
    expect(r.headers.get("Content-Length")).toBe("8");
    expect(await r.text()).toBe(BODY.slice(2, 10));
  });

  it("open: bytes=5- runs to the end", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/p/${id}`, { headers: { Range: "bytes=5-" } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe(BODY.slice(5));
  });

  it("suffix: bytes=-4 returns exactly the last 4 bytes", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/p/${id}`, { headers: { Range: "bytes=-4" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe(`bytes ${BODY.length - 4}-${BODY.length - 1}/${BODY.length}`);
    expect(await r.text()).toBe(BODY.slice(-4));
  });

  it("suffix larger than the file returns the whole body (per RFC 9110)", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/p/${id}`, { headers: { Range: "bytes=-9999" } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe(BODY);
  });

  it("416 with Content-Range: bytes */size on unsatisfiable ranges", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/p/${id}`, { headers: { Range: "bytes=999-1000" } });
    expect(r.status).toBe(416);
    expect(r.headers.get("Content-Range")).toBe(`bytes */${BODY.length}`);
    await r.text();
  });

  it("ignores malformed Range headers (full 200)", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/p/${id}`, { headers: { Range: "bytes=a-b" } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(BODY);
  });
});

describe("delete", () => {
  it("removes the row, the R2 object, and audits the action", async () => {
    const id = await resetAndUpload();
    const r = await fetch(`https://example.com/api/delete/${id}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(await env.BUCKET.get(`p/${id}`)).toBeNull();
    const row = await env.DB.prepare("SELECT id FROM docs WHERE id = ?").bind(id).first();
    expect(row).toBeNull();
    const audit = await env.DB.prepare("SELECT action FROM actions ORDER BY ts DESC").first();
    expect(audit.action).toBe("delete");
  });

  it("400s on malformed ids", async () => {
    const r = await fetch("https://example.com/api/delete/;DROP TABLE docs", { method: "DELETE" });
    expect(r.status).toBe(400);
  });
});
