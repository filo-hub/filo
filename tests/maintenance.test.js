// Maintenance: reconcile() via POST /api/reconcile — dead rows dropped,
// legacy p/<id>.pdf objects migrated, live rows untouched, report accurate.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

const fetch = (...args) => SELF.fetch(...args);

async function seedDoc(id, filename, opts = {}) {
  await env.DB.prepare(
    "INSERT INTO docs (id, filename, size, uploaded_at, title) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, filename, opts.size ?? 10, Date.now(), opts.title ?? null).run();
  if (opts.withObject !== false) {
    await env.BUCKET.put(`p/${id}`, "seed-content", {
      httpMetadata: { contentType: "text/plain" },
    });
  }
  if (opts.legacyPdf) {
    await env.BUCKET.put(`p/${id}.pdf`, "legacy-content", {
      httpMetadata: { contentType: "application/pdf" },
    });
  }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM docs").run();
  await env.DB.prepare("DELETE FROM actions").run();
});

describe("reconcile", () => {
  it("drops rows whose object is missing", async () => {
    await seedDoc("deadrow1", "dead.txt", { withObject: false });
    await seedDoc("aliverow", "alive.txt");
    const r = await fetch("https://example.com/api/reconcile", { method: "POST" });
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.report.checked).toBe(2);
    expect(j.report.droppedRows).toBe(1);
    const row = await env.DB.prepare("SELECT id FROM docs WHERE id = 'deadrow1'").first();
    expect(row).toBeNull();
    const kept = await env.DB.prepare("SELECT id FROM docs WHERE id = 'aliverow'").first();
    expect(kept).not.toBeNull();
  });

  it("migrates legacy p/<id>.pdf objects to p/<id>", async () => {
    await seedDoc("legacy11", "old.pdf", { withObject: false, legacyPdf: true });
    const r = await fetch("https://example.com/api/reconcile", { method: "POST" });
    const j = await r.json();
    expect(j.report.migrated).toBe(1);
    expect(j.report.droppedRows).toBe(0);
    const obj = await env.BUCKET.get("p/legacy11");
    expect(obj).not.toBeNull();
    expect(await obj.text()).toBe("legacy-content");
    const row = await env.DB.prepare("SELECT id FROM docs WHERE id = 'legacy11'").first();
    expect(row).not.toBeNull();
  });

  it("keeps the existing object when both layouts are present", async () => {
    await seedDoc("both0001", "b.txt", { legacyPdf: true }); // p/<id> + p/<id>.pdf
    const j = await (await fetch("https://example.com/api/reconcile", { method: "POST" })).json();
    expect(j.report.migrated).toBe(0);
    expect(j.report.droppedRows).toBe(0);
    expect(await (await env.BUCKET.get("p/both0001")).text()).toBe("seed-content");
  });

  it("audits the run", async () => {
    await seedDoc("xrow0001", "x.txt");
    await fetch("https://example.com/api/reconcile", { method: "POST" });
    const a = await env.DB.prepare("SELECT action, detail FROM actions ORDER BY ts DESC").first();
    expect(a.action).toBe("cleanup");
    expect(a.detail).toContain('"checked":1');
  });
});
