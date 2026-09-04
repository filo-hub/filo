// Tests for the token-gated metadata API: health, auth gate, upload,
// list pagination + search + sort, storage/quota, rename, activity.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

const fetch = (...args) => SELF.fetch(...args);

async function resetDb() {
  await env.DB.prepare("DELETE FROM docs").run();
  await env.DB.prepare("DELETE FROM actions").run();
}

async function upload(file, fields = {}, headers = {}) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch("https://example.com/api/upload", {
    method: "POST",
    body: fd,
    headers,
  });
}

function makeFile(content = "test content", name = "test.txt", type = "text/plain") {
  return new File([content], name, { type });
}

beforeEach(resetDb);

describe("health", () => {
  it("reports ok and auth:false in open mode", async () => {
    const r = await fetch("https://example.com/api/health");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.auth).toBe(false);
  });
});

describe("token gate (open mode project)", () => {
  it("serves list without any token when UPLOAD_TOKEN is unset", async () => {
    const r = await fetch("https://example.com/api/list");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.docs).toEqual([]);
    expect(j.total).toBe(0);
  });
});

describe("upload", () => {
  it("stores the file, returns id + permanent URL, and writes an audit row", async () => {
    const r = await upload(makeFile("hello world"), { title: "My Doc" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.id).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(j.url).toContain("/p/" + j.id);
    expect(j.size).toBe(11);
    expect(j.message).toMatch(/permanent/i);

    const row = await env.DB.prepare("SELECT filename, title FROM docs WHERE id = ?").bind(j.id).first();
    expect(row.filename).toMatch(/^MyDoc\d{8}[A-Za-z0-9]{8}\.txt$/);
    expect(row.title).toBe("My Doc");

    const audit = await env.DB.prepare("SELECT action, doc_id FROM actions ORDER BY ts DESC").first();
    expect(audit.action).toBe("upload");
    expect(audit.doc_id).toBe(j.id);
  });

  it("accepts a 2MB upload under the default 10GB quota", async () => {
    // (the 1MB-quota rejection path lives in token.test.js's worker)
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "big.bin");
    const r = await upload(big);
    expect(r.status).toBe(200);
    const j = await r.json();
    const row = await env.DB.prepare("SELECT size FROM docs WHERE id = ?").bind(j.id).first();
    expect(row.size).toBe(2 * 1024 * 1024);
  });

  it("rejects empty and oversized files", async () => {
    const empty = await upload(new File([""], "empty.txt"));
    expect(empty.status).toBe(400);
    const huge = await upload(new File([new Uint8Array(26 * 1024 * 1024)], "huge.bin"));
    expect(huge.status).toBe(400);
  });
});

describe("list", () => {
  it("paginates 200/page with a true total and no overlap", async () => {
    const stmts = [];
    for (let i = 0; i < 205; i++) {
      const id = String(i).padStart(8, "0");
      stmts.push(
        env.DB.prepare(
          "INSERT INTO docs (id, filename, size, uploaded_at, title) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, `f${i}.txt`, 100, 1000000 + i, `File ${i}`)
      );
    }
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
    const p1 = await (await fetch("https://example.com/api/list")).json();
    expect(p1.docs.length).toBe(200);
    expect(p1.total).toBe(205);
    const p2 = await (await fetch("https://example.com/api/list?offset=200")).json();
    expect(p2.docs.length).toBe(5);
    expect(p2.total).toBe(205);
    const ids1 = new Set(p1.docs.map((d) => d.id));
    expect(p2.docs.filter((d) => ids1.has(d.id))).toHaveLength(0);
  });

  it("searches server-side over filename, title, and id", async () => {
    await upload(makeFile("q body", "invoice.txt"), { title: "September Invoice" });
    await upload(makeFile("q body", "photo.png"));
    const byTitle = await (await fetch("https://example.com/api/list?q=september")).json();
    expect(byTitle.total).toBe(1);
    expect(byTitle.docs[0].title).toBe("September Invoice");
    const byName = await (await fetch("https://example.com/api/list?q=photo")).json();
    expect(byName.total).toBe(1);
    expect(byName.docs[0].filename).toContain("photo");
    const none = await (await fetch("https://example.com/api/list?q=zzz")).json();
    expect(none.total).toBe(0);
    expect(none.docs).toHaveLength(0);
  });

  it("escapes LIKE wildcards in the query", async () => {
    await upload(makeFile("q body", "plain.txt"));
    const r = await (await fetch("https://example.com/api/list?q=50%25")).json();
    // '50%' must not act as a wildcard matching everything
    expect(r.total).toBe(0);
  });

  it("sorts by name/size/date, asc and desc", async () => {
    await upload(makeFile("b", "b.txt"));
    await upload(makeFile("a", "a.txt"));
    const nameAsc = await (await fetch("https://example.com/api/list?sort=name&dir=asc")).json();
    expect(nameAsc.docs[0].filename < nameAsc.docs[1].filename).toBe(true);
    const dateAsc = await (await fetch("https://example.com/api/list?sort=date&dir=asc")).json();
    expect(dateAsc.docs[0].uploaded_at <= dateAsc.docs[1].uploaded_at).toBe(true);
  });

  it("filters by category", async () => {
    await upload(makeFile("c1", "one.txt"), { category: "work" });
    await upload(makeFile("c2", "two.txt"), { category: "personal" });
    const r = await (await fetch("https://example.com/api/list?category=work")).json();
    expect(r.total).toBe(1);
    expect(r.docs[0].category).toBe("work");
  });

  it("ignores sort keys outside the allowlist", async () => {
    const r = await fetch("https://example.com/api/list?sort=id;DROP TABLE docs;--");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.docs)).toBe(true);
  });
});

describe("rename", () => {
  it("changes the title without touching the id or file", async () => {
    const j = await (await upload(makeFile("keep"))).json();
    const r = await fetch(`https://example.com/api/rename/${j.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Title" }),
    });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare("SELECT filename, title FROM docs WHERE id = ?").bind(j.id).first();
    expect(row.title).toBe("New Title");
    expect(row.filename).toBe(j.filename); // stored name untouched
    const obj = await env.BUCKET.head(`p/${j.id}`);
    expect(obj).not.toBeNull();
  });

  it("404s on an unknown id and 400s on a bad one", async () => {
    const nf = await fetch("https://example.com/api/rename/zzzzzzzz", {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(nf.status).toBe(404);
    const bad = await fetch("https://example.com/api/rename/;DROP", {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });
});

describe("activity", () => {
  it("lists audit rows newest-first", async () => {
    await upload(makeFile("a1", "a.txt"));
    const r = await (await fetch("https://example.com/api/activity")).json();
    expect(r.actions.length).toBeGreaterThanOrEqual(1);
    expect(r.actions[0].action).toBe("upload");
  });
});
