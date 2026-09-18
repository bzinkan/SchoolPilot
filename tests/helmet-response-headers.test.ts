import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

// Parity guard for the helmet posture in src/app.ts: every reviewed response header is
// pinned byte-for-byte so a helmet major bump (or a changed default) shows up here first,
// not in production. NODE_ENV=test keeps HSTS off, as it is outside production.
const PINNED_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none';font-src 'self' https: data:;img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "x-download-options": "noopen",
  "x-frame-options": "DENY",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
const ABSENT_HEADERS = ["cross-origin-embedder-policy", "strict-transport-security", "x-powered-by"];

test("every response carries the reviewed security headers", { timeout: 120_000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "security headers require the coordinated local PostgreSQL fixture");
  process.env.SCHEDULER_ENABLED = "false";
  process.env.REDIS_URL = "";
  process.env.NODE_ENV = "test";
  const { createApp } = await import("../src/app.js");
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const path of ["/api/security-headers-probe", "/livez"]) {
    const response = await fetch(`${origin}${path}`);
    await response.text();
    const actual: Record<string, string | null> = {};
    for (const name of Object.keys(PINNED_HEADERS)) actual[name] = response.headers.get(name);
    assert.deepEqual(actual, PINNED_HEADERS, `${path} must carry the pinned security headers`);
    for (const name of ABSENT_HEADERS) {
      assert.equal(response.headers.get(name), null, `${path} must not send ${name}`);
    }
  }
});
