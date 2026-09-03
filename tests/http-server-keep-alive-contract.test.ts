import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// AWS default ALB idle timeout; infra/modules/alb/main.tf sets none. A task
// that closes a pooled socket before the ALB stops reusing it produces an
// ELB-generated 502 with target_status_code "-" and a 0-30 ms target time.
const ALB_IDLE_TIMEOUT_MS = 60_000;

const indexSource = readFileSync(
  resolve(import.meta.dirname, "..", "src", "index.ts"),
  "utf8"
);

// The two assignments must sit directly after the server is created (only
// comment lines may separate them) and in this order, so nothing can attach to
// the server before its timeouts are set.
const TIMEOUT_ASSIGNMENTS =
  /const server = http\.createServer\(app\);\r?\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*server\.keepAliveTimeout = (\d[\d_]*);\r?\n[ \t]*server\.headersTimeout = (\d[\d_]*);/;

function configuredTimeouts(): { keepAliveTimeout: number; headersTimeout: number } {
  const match = indexSource.match(TIMEOUT_ASSIGNMENTS);
  assert.ok(
    match,
    "src/index.ts must set server.keepAliveTimeout then server.headersTimeout immediately after http.createServer(app)"
  );
  return {
    keepAliveTimeout: Number(match[1].replaceAll("_", "")),
    headersTimeout: Number(match[2].replaceAll("_", "")),
  };
}

function closeHttpServerSource(): string {
  const start = indexSource.indexOf("function closeHttpServer(): Promise<void> {");
  assert.ok(start >= 0, "closeHttpServer must be declared in src/index.ts");
  const end = indexSource.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, "closeHttpServer must be followed by another top-level function");
  return indexSource.slice(start, end);
}

describe("HTTP server keep-alive contract", () => {
  it("sets keepAliveTimeout and headersTimeout immediately after http.createServer(app)", () => {
    const timeouts = configuredTimeouts();
    assert.ok(Number.isInteger(timeouts.keepAliveTimeout));
    assert.ok(Number.isInteger(timeouts.headersTimeout));
  });

  it("keeps keepAliveTimeout above the ALB idle timeout", () => {
    const { keepAliveTimeout } = configuredTimeouts();
    assert.ok(
      keepAliveTimeout > ALB_IDLE_TIMEOUT_MS,
      `keepAliveTimeout ${keepAliveTimeout} must exceed the ALB idle timeout ${ALB_IDLE_TIMEOUT_MS}`
    );
  });

  it("keeps headersTimeout above keepAliveTimeout", () => {
    const { keepAliveTimeout, headersTimeout } = configuredTimeouts();
    assert.ok(
      headersTimeout > keepAliveTimeout,
      `headersTimeout ${headersTimeout} must exceed keepAliveTimeout ${keepAliveTimeout}`
    );
  });

  it("drains idle keep-alive sockets before server.close in closeHttpServer", () => {
    const source = closeHttpServerSource();
    const drain = source.indexOf("server.closeIdleConnections();");
    const close = source.indexOf("server.close(");
    assert.ok(drain >= 0, "closeHttpServer must call server.closeIdleConnections()");
    assert.ok(close >= 0, "closeHttpServer must call server.close(");
    assert.ok(drain < close, "closeIdleConnections() must precede server.close(");
  });

  it("applies the configured values to a node:http server", () => {
    const server = http.createServer();
    try {
      // The premise of the fix: Node's default is below the ALB idle timeout.
      assert.ok(
        server.keepAliveTimeout < ALB_IDLE_TIMEOUT_MS,
        `Node default keepAliveTimeout ${server.keepAliveTimeout} is expected below the ALB idle timeout`
      );
      assert.equal(typeof server.closeIdleConnections, "function");

      const { keepAliveTimeout, headersTimeout } = configuredTimeouts();
      server.keepAliveTimeout = keepAliveTimeout;
      server.headersTimeout = headersTimeout;
      assert.equal(server.keepAliveTimeout, keepAliveTimeout);
      assert.equal(server.headersTimeout, headersTimeout);
    } finally {
      server.closeIdleConnections();
    }
  });
});
