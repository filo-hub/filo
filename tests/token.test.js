// Token mode + quota: run the whole worker with UPLOAD_TOKEN set and
// MAX_STORAGE_MB=1 by binding them as vars for this test file's isolated
// worker instance (vitest-pool-workers gives each test file its own).
// `import { env }` bindings come from wrangler.toml; extra vars come from
// the `bindings` block vitest.config.js adds for this project.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const fetch = (...args) => SELF.fetch(...args);

const TOKEN = "test-token-123";
const H = { "x-upload-token": TOKEN };
const HB = { Authorization: `Bearer ${TOKEN}` };

function makeFile(bytes, name = "f.bin") {
  return new File([new Uint8Array(bytes)], name, { type: "application/octet-stream" });
}

describe("token-gated API", () => {
  it("health stays public and reports auth:true", async () => {
    const r = await fetch("https://example.com/api/health");
    expect(r.status).toBe(200);
    expect((await r.json()).auth).toBe(true);
  });

  it("blocks every protected route without a token", async () => {
    const routes = [
      ["GET", "/api/list"],
      ["GET", "/api/storage"],
      ["GET", "/api/activity"],
      ["POST", "/api/upload"],
      ["DELETE", "/api/delete/abc12345"],
      ["POST", "/api/reconcile"],
    ];
    for (const [m, p] of routes) {
      const r = await fetch(`https://example.com${p}`, { method: m });
      expect(r.status).toBe(401);
    }
  });

  it("rejects a wrong token in both header styles", async () => {
    expect((await fetch("https://example.com/api/list", { headers: { "x-upload-token": "wrong" } })).status).toBe(401);
    expect((await fetch("https://example.com/api/list", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("accepts the right token in both header styles", async () => {
    expect((await fetch("https://example.com/api/list", { headers: H })).status).toBe(200);
    expect((await fetch("https://example.com/api/storage", { headers: HB })).status).toBe(200);
  });
});

describe("storage quota (MAX_STORAGE_MB=1)", () => {
  it("accepts uploads under 1MB", async () => {
    const fd = new FormData();
    fd.append("file", makeFile(1000), "small.bin");
    const r = await fetch("https://example.com/api/upload", { method: "POST", body: fd, headers: H });
    expect(r.status).toBe(200);
  });

  it("rejects a 2MB upload with 507 before writing anything", async () => {
    const fd = new FormData();
    fd.append("file", makeFile(2 * 1024 * 1024), "big.bin");
    const r = await fetch("https://example.com/api/upload", { method: "POST", body: fd, headers: H });
    expect(r.status).toBe(507);
    expect(((await r.json()).error || "").toLowerCase()).toContain("quota");
  });
});
