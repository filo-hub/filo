// Tests for magic link authentication: request link, verify link,
// session cookie, and upload protection when not authenticated.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

const fetch = (...args) => SELF.fetch(...args);

async function resetDb() {
  await env.DB.prepare("DELETE FROM docs").run();
  await env.DB.prepare("DELETE FROM actions").run();
  await env.DB.prepare("DELETE FROM magic_links").run();
  // rate windows are per-file-worker shared: reset so mint-count tests
  // never starve each other (all use the default client IP here)
  await env.DB.prepare("DELETE FROM rate_limits").run();
}

beforeEach(resetDb);

describe("magic link auth", () => {
  it("requests a magic link for a valid email", async () => {
    const r = await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.link).toMatch(/\/api\/login\//);
    expect(j.email).toBe("user@example.com");

    // Row persisted
    const row = await env.DB.prepare("SELECT email, used FROM magic_links WHERE email = ?").bind("user@example.com").first();
    expect(row).not.toBeNull();
    expect(row.used).toBe(0);
  });

  it("rejects invalid emails", async () => {
    const r = await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(r.status).toBe(400);
  });

  it("verifies a magic link and sets a session cookie", async () => {
    // Create a link manually
    const r = await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const j = await r.json();
    const id = j.link.split("/").pop();

    const verify = await fetch(`https://example.com/api/login/${id}`, { redirect: "manual" });
    expect(verify.status).toBe(302);
    const setCookie = verify.headers.get("Set-Cookie") || "";
    expect(setCookie).toContain("filo_session=");
    expect(setCookie).toContain("HttpOnly");

    // Row is now marked used
    const row = await env.DB.prepare("SELECT used FROM magic_links WHERE id = ?").bind(id).first();
    expect(row.used).toBe(1);
  });

  it("rejects an unknown or already-used link", async () => {
    const r = await fetch("https://example.com/api/login/doesnotexist");
    expect(r.status).toBe(400);
  });

  it("consumes a link atomically — replaying it fails", async () => {
    const r = await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const id = (await r.json()).link.split("/").pop();

    const first = await fetch(`https://example.com/api/login/${id}`, { redirect: "manual" });
    expect(first.status).toBe(302);
    const second = await fetch(`https://example.com/api/login/${id}`, { redirect: "manual" });
    expect(second.status).toBe(400);
  });

  it("prunes expired links when minting a new one", async () => {
    await env.DB.prepare(
      "INSERT INTO magic_links (id, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)"
    ).bind("expired0000000001", "old@example.com", Date.now() - 1000, Date.now() - 2000).run();

    await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });

    const gone = await env.DB.prepare("SELECT id FROM magic_links WHERE id = ?").bind("expired0000000001").first();
    expect(gone).toBeNull();
  });

  it("sets a Secure session cookie", async () => {
    const r = await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const id = (await r.json()).link.split("/").pop();
    const verify = await fetch(`https://example.com/api/login/${id}`, { redirect: "manual" });
    expect(verify.headers.get("Set-Cookie")).toContain("Secure");
  });

  it("health reports auth:true (but no identity) when session cookie present", async () => {
    // Request link, verify, grab cookie
    const r = await fetch("https://example.com/api/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const id = (await r.json()).link.split("/").pop();
    const verify = await fetch(`https://example.com/api/login/${id}`, { redirect: "manual" });
    const cookie = (verify.headers.get("Set-Cookie") || "").split(";")[0];

    const health = await fetch("https://example.com/api/health", {
      headers: { Cookie: cookie },
    });
    const j = await health.json();
    expect(j.auth).toBe(true);
    expect(j.user).toBeUndefined();
  });
});