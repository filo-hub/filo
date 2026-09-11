import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Worker integration tests run against real miniflare D1/R2 via
// @cloudflare/vitest-pool-workers — separate from vite.config.js (app build).
// Bindings come from tests/wrangler.test.toml (bindings-only copy of
// wrangler.toml — no [assets], since tests run before dist/ is built).
// Two isolated projects, each with fresh D1/R2 and migrations applied:
//   app   — open mode (no UPLOAD_TOKEN): the default single-user setup
//   token — UPLOAD_TOKEN set + MAX_STORAGE_MB=1: auth gate + quota paths
const pool = (vars) => ({
  wrangler: { configPath: "./tests/wrangler.test.toml" },
  // keep ALL bindings local — no remote proxy session against real D1
  remoteBindings: false,
  ...(vars ? { miniflare: { bindings: vars } } : {}),
});

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest(pool())],
        test: {
          name: "app",
          include: ["tests/api.test.js", "tests/files.test.js", "tests/maintenance.test.js", "tests/magic.test.js", "tests/naming.test.js", "tests/ratelimit.test.js"],
          setupFiles: ["./tests/setup.js"],
        },
      },
      {
        plugins: [cloudflareTest(pool({ UPLOAD_TOKEN: "test-token-123", MAX_STORAGE_MB: "1" }))],
        test: {
          name: "token",
          include: ["tests/token.test.js"],
          setupFiles: ["./tests/setup.js"],
        },
      },
    ],
  },
});
