// Rate limiting: fixed D1 windows on upload, request-link, and login.
// Each test uses a distinct fake client IP (cf-connecting-ip) so the
// shared rate_limits table can't leak between tests.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

const fetch = (...args) => SELF.fetch(...args);
const IP = (n) => ({ "cf-connecting-ip": `10.9.9.${n}` });

async function resetDb() {
  await env.DB.prepare("DELETE FROM docs").run();
  await env.DB.prepare("DELETE FROM actions").run();
  await env.DB.prepare("DELETE FROM magic_links").run();
  await env.DB.prepare("DELETE FROM rate_limits").run();
}

beforeEach(resetDb);

describe("throttles", () => {
  it("caps magic-link minting at 5/hour per IP with Retry-After", async () => {
    const h = { ...IP(1), "Content-Type": "application/json" };
    for (let i = 0; i < 5; i++) {
      const r = await fetch("https://example.com/api/request-link", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ email: "user@example.com" }),
      });
      expect(r.status).toBe(200);
    }
    const limited = await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ email: "user@example.com" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(((await limited.json()).error || "").toLowerCase()).toContain("too many");
  });

  it("caps magic-link minting per email across IPs", async () => {
    for (let n = 2; n <= 6; n++) {
      const r = await fetch("https://example.com/api/request-link", {
        method: "POST",
        headers: { ...IP(n), "Content-Type": "application/json" },
        body: JSON.stringify({ email: "popular@example.com" }),
      });
      expect(r.status).toBe(200);
    }
    const limited = await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: { ...IP(7), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "popular@example.com" }),
    });
    expect(limited.status).toBe(429);
  });

  it("caps login attempts per IP", async () => {
    const h = IP(8);
    for (let i = 0; i < 30; i++) {
      await fetch(`https://example.com/api/login/${"a".repeat(16)}`, { headers: h });
    }
    const limited = await fetch(`https://example.com/api/login/${"b".repeat(16)}`, { headers: h });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("caps uploads at 30/hour per IP, then recovers the shape", async () => {
    const h = IP(9);
    for (let i = 0; i < 30; i++) {
      const fd = new FormData();
      fd.append("file", new File(["x"], `f${i}.txt`, { type: "text/plain" }));
      const r = await fetch("https://example.com/api/upload", { method: "POST", headers: h, body: fd });
      expect(r.status).toBe(200);
    }
    const fd = new FormData();
    fd.append("file", new File(["y"], "one-too-many.txt", { type: "text/plain" }));
    const limited = await fetch("https://example.com/api/upload", { method: "POST", headers: h, body: fd });
    expect(limited.status).toBe(429);
    // and a different IP is unaffected
    const fd2 = new FormData();
    fd2.append("file", new File(["z"], "other-ip.txt", { type: "text/plain" }));
    const ok = await fetch("https://example.com/api/upload", {
      method: "POST",
      headers: IP(10),
      body: fd2,
    });
    expect(ok.status).toBe(200);
  });
});
