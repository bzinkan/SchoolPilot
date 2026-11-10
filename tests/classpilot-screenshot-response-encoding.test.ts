import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";
import { test } from "node:test";
import express from "express";
import { createScreenshotResponseEncoder } from "../src/services/classpilotScreenshotResponseEncoding.js";

const body = { tiles: [{ studentId: "synthetic-student", screenshot: {
  screenshot: `data:image/jpeg;base64,${"synthetic-compressed-image".repeat(400)}`,
  timestamp: 1794290000000, bindingVersion: "v2:synthetic",
  tabTitle: "A <lesson> & notes", tabUrl: "https://example.invalid/lesson",
} }] };

type Encoder = ReturnType<typeof createScreenshotResponseEncoder>;
async function fixture(encoder: Encoder, configure?: (app: express.Express) => void) {
  const app = express();
  configure?.(app);
  app.post("/tiles/screenshots", async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.vary("Origin");
    try {
      const prepared = await encoder.prepare(req, res, body);
      encoder.send(res, body, prepared);
    } catch (error) { next(error); }
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}
async function raw(server: Server, acceptEncoding?: string) {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, method: "POST", path: "/tiles/screenshots",
      headers: acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test("authorized screenshot JSON uses negotiated gzip without changing pixel or metadata bytes", async () => {
  const server = await fixture(createScreenshotResponseEncoder({ timeoutMs: 1000 }));
  try {
    const response = await raw(server, "gzip, deflate, br");
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(String(response.headers.vary), /Origin/);
    assert.match(String(response.headers.vary), /Accept-Encoding/);
    assert.equal(Number(response.headers["content-length"]), response.body.length);
    assert.deepEqual(gunzipSync(response.body), Buffer.from(JSON.stringify(body)));
    assert.ok(response.body.length < Buffer.byteLength(JSON.stringify(body)));
  } finally { await close(server); }
});

test("quality weights and unsupported encodings retain the identity representation", async () => {
  const server = await fixture(createScreenshotResponseEncoder({ timeoutMs: 1000 }));
  try {
    for (const encoding of [undefined, "br", "gzip;q=0", "gzip;q=0, *;q=1", "gzip;q=0.4, identity;q=1"]) {
      const response = await raw(server, encoding);
      assert.equal(response.headers["content-encoding"], undefined, String(encoding));
      assert.deepEqual(response.body, Buffer.from(JSON.stringify(body)), String(encoding));
      assert.match(String(response.headers.vary), /Accept-Encoding/);
    }
    assert.equal((await raw(server, "gzip;q=0.8, identity;q=0.1")).headers["content-encoding"], "gzip");
  } finally { await close(server); }
});

test("compressed JSON preserves Express replacer, indentation and HTML escaping", async () => {
  const configure = (app: express.Express) => {
    app.set("json replacer", (key: string, value: unknown) => key === "tabUrl" ? undefined : value);
    app.set("json spaces", 2);
    app.set("json escape", true);
  };
  const server = await fixture(createScreenshotResponseEncoder({ timeoutMs: 1000 }), configure);
  try {
    const encoded = await raw(server, "gzip");
    const identity = await raw(server, "identity");
    assert.deepEqual(gunzipSync(encoded.body), identity.body);
    const text = identity.body.toString();
    assert.ok(text.includes('"tiles": [\n'));
    assert.ok(text.includes("A \\u003clesson\\u003e \\u0026 notes"));
    assert.ok(!text.includes("tabUrl"));
  } finally { await close(server); }
});

test("saturation never queues another compression or blocks an identity response", async () => {
  let release!: (value: Buffer) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const encoder = createScreenshotResponseEncoder({ maxConcurrent: 1, timeoutMs: 1000,
    compress: async () => { calls++; started(); return new Promise<Buffer>(resolve => { release = resolve; }); } });
  const server = await fixture(encoder);
  try {
    const first = raw(server, "gzip");
    await ready;
    const second = await raw(server, "gzip");
    assert.equal(calls, 1);
    assert.equal(second.headers["content-encoding"], undefined);
    assert.deepEqual(second.body, Buffer.from(JSON.stringify(body)));
    release(gzipSync(Buffer.from(JSON.stringify(body))));
    assert.equal((await first).headers["content-encoding"], "gzip");
  } finally { release?.(Buffer.alloc(0)); await close(server); }
});

test("a timed-out compressor retains its permit until the physical work settles", async () => {
  let release!: (value: Buffer) => void;
  let calls = 0;
  const encoder = createScreenshotResponseEncoder({ maxConcurrent: 1, timeoutMs: 10,
    compress: async input => { calls++; return calls > 1 ? gzipSync(input) : new Promise<Buffer>(resolve => { release = resolve; }); } });
  const server = await fixture(encoder);
  try {
    const first = await raw(server, "gzip");
    assert.equal(first.headers["content-encoding"], undefined);
    const second = await raw(server, "gzip");
    assert.equal(second.headers["content-encoding"], undefined);
    assert.equal(calls, 1, "deadline must not free a still-running physical slot");
    release(gzipSync(Buffer.from(JSON.stringify(body))));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await raw(server, "gzip")).headers["content-encoding"], "gzip");
    assert.equal(calls, 2, "settled physical work releases its slot for later responses");
  } finally { release?.(Buffer.alloc(0)); await close(server); }
});

test("existing content types and encodings keep Express identity behavior rather than double encoding", async () => {
  for (const headers of [{ "Content-Type": "application/problem+json; charset=iso-8859-1" }, { "Content-Encoding": "identity" }]) {
    let calls = 0;
    const server = await fixture(createScreenshotResponseEncoder({ compress: async input => { calls++; return gzipSync(input); } }), app => {
      app.use((_req, res, next) => { res.set(headers); next(); });
    });
    try {
      const response = await raw(server, "gzip");
      assert.deepEqual(response.body, Buffer.from(JSON.stringify(body)));
      assert.equal(calls, 0);
      assert.notEqual(response.headers["content-encoding"], "gzip");
      if (headers["Content-Type"]) assert.equal(response.headers["content-type"], "application/problem+json; charset=utf-8");
    } finally { await close(server); }
  }
});

test("compressor errors and expansion fall back to the exact identity bytes", async () => {
  for (const compress of [async () => { throw new Error("synthetic compressor failure"); }, async () => Buffer.alloc(100000)]) {
    const server = await fixture(createScreenshotResponseEncoder({ compress }));
    try {
      const response = await raw(server, "gzip");
      assert.equal(response.headers["content-encoding"], undefined);
      assert.deepEqual(response.body, Buffer.from(JSON.stringify(body)));
    } finally { await close(server); }
  }
});

test("small or oversized bodies skip compression without changing JSON semantics", async () => {
  let calls = 0;
  const server = await fixture(createScreenshotResponseEncoder({ maxBytes: 1024, compress: async input => { calls++; return gzipSync(input); } }));
  try {
    const response = await raw(server, "gzip");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(response.body, Buffer.from(JSON.stringify(body)));
    assert.equal(calls, 0);
  } finally { await close(server); }
  const smallServer = await fixture(createScreenshotResponseEncoder({ minBytes: 100000, compress: async input => { calls++; return gzipSync(input); } }));
  try { assert.equal((await raw(smallServer, "gzip")).headers["content-encoding"], undefined); assert.equal(calls, 0); }
  finally { await close(smallServer); }
});
