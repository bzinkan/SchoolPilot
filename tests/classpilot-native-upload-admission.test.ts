import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request, type ClientRequest } from "node:http";
import { test } from "node:test";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { createNativeUploadAdmission } from "../src/services/classpilotNativeUploadAdmission.js";
import { ClasspilotNativeError } from "../src/services/classpilotNativeProtocol.js";

const boundary = "native-upload-regression";
const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n`
  + `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="thumbnail.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
const suffix = `\r\n--${boundary}--\r\n`;
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const body = Buffer.concat([Buffer.from(prefix), jpeg, Buffer.from(suffix)]);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(options: { budgetMs?: number; delayedParser?: boolean; authGate?: ReturnType<typeof deferred>;
  workGate?: ReturnType<typeof deferred> } = {}) {
  const admission = createNativeUploadAdmission();
  const events = new EventEmitter();
  const admitted = new Map<string, { req: Request; res: Response; at: number;
    listeners: { finish: Function[]; close: Function[]; aborted: Function[] } }>();
  const authenticating = new Map<string, Request>();
  const finished = new Set<string>();
  const parsed: string[] = [];
  const published: string[] = [];
  const parserCallbacks: Array<() => void> = [];
  const clients = new Set<ClientRequest>();
  const app = express();
  const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024, files: 1, fields: 1, parts: 2 } }).single("image");
  const controlledParser: RequestHandler = (req, res, next) => parser(req, res, error => {
    if (options.delayedParser) { parserCallbacks.push(() => next(error)); events.emit("parser"); }
    else next(error);
  });
  app.post("/upload", (req, res, next) => {
    void (async () => {
      const key = req.get("Authorization")?.match(/^Bearer (session-[a-z])$/)?.[1];
      if (!key) { res.sendStatus(401); return; }
      authenticating.set(key, req);
      events.emit(`authenticating:${key}`);
      await options.authGate?.promise;
      const before = { finish: res.listeners("finish"), close: res.listeners("close"), aborted: req.listeners("aborted") };
      admission.admit(req, res, key, options.budgetMs ?? 400);
      admitted.set(key, { req, res, at: performance.now(), listeners: {
        finish: res.listeners("finish").filter(listener => !before.finish.includes(listener)),
        close: res.listeners("close").filter(listener => !before.close.includes(listener)),
        aborted: req.listeners("aborted").filter(listener => !before.aborted.includes(listener)),
      } });
      const closed = () => { finished.add(key); events.emit(`finished:${key}`); };
      res.once("finish", closed); res.once("close", closed);
      events.emit(`admitted:${key}`);
      next();
    })().catch(next);
  }, admission.guardParser(controlledParser), (req, res, next) => {
    void (async () => {
      admission.assertActive(req);
      const key = req.get("Authorization")!.slice(7);
      parsed.push(key);
      events.emit(`parsed:${key}`);
      assert.ok(req.file);
      assert.deepEqual(req.file.buffer, jpeg);
      await options.workGate?.promise;
      admission.assertActive(req);
      published.push(key);
      res.status(201).json({ accepted: true });
    })().catch(next);
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.destroyed || res.writableEnded) return;
    res.status(error instanceof ClasspilotNativeError ? error.status : 400).json({ code: error.code ?? "INVALID_MULTIPART" });
  };
  app.use(errors);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  function start(session = "session-a", contentType = `multipart/form-data; boundary=${boundary}`) {
    let settle!: (result: { status: number; body: string }) => void;
    const done = new Promise<{ status: number; body: string }>(resolve => { settle = resolve; });
    const client = request({ hostname: "127.0.0.1", port, path: "/upload", method: "POST",
      headers: { Authorization: `Bearer ${session}`, "Content-Type": contentType, "Transfer-Encoding": "chunked" } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => settle({ status: response.statusCode ?? 0, body: text }));
      response.on("error", () => settle({ status: 0, body: "" }));
    });
    client.on("error", () => settle({ status: 0, body: "" }));
    client.on("close", () => { clients.delete(client); settle({ status: 0, body: "" }); });
    clients.add(client);
    return { client, done };
  }
  async function send(session: string, bytes: Buffer | string = body, contentType?: string) {
    const upload = start(session, contentType);
    upload.client.end(bytes);
    return upload.done;
  }
  return { admitted, authenticating, parsed, published, parserCallbacks, events, start, send,
    waitAuthenticating: async (key: string) => { if (!authenticating.has(key)) await once(events, `authenticating:${key}`); },
    waitAdmitted: async (key: string) => { if (!admitted.has(key)) await once(events, `admitted:${key}`); },
    waitFinished: async (key: string) => { if (!finished.has(key)) await once(events, `finished:${key}`); },
    close: async () => {
      for (const client of clients) client.destroy();
      options.authGate?.resolve(); options.workGate?.resolve();
      for (const callback of parserCallbacks.splice(0)) callback();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}

test("absolute upload deadline expires both slots despite trickled bytes and admits a later upload", { timeout: 10_000 }, async () => {
  const f = await fixture({ budgetMs: 4_000 });
  const a = f.start("session-a"), b = f.start("session-b");
  let chunks = 0;
  const trickle = setInterval(() => {
    chunks++;
    for (const upload of [a, b]) if (!upload.client.destroyed) upload.client.write("x");
  }, 20);
  try {
    a.client.write(prefix); b.client.write(prefix);
    await Promise.all([f.waitAdmitted("session-a"), f.waitAdmitted("session-b")]);
    assert.equal((await f.send("session-a")).status, 429, "same session cannot reserve a second slot");
    assert.equal((await f.send("session-c")).status, 429, "two active uploads exhaust the process cap");
    assert.deepEqual((await Promise.all([a.done, b.done])).map(result => result.status), [0, 0]);
    await Promise.all([f.waitFinished("session-a"), f.waitFinished("session-b")]);
    assert.ok(chunks >= 2, "body bytes continued arriving before the absolute deadline");
    for (const record of f.admitted.values()) assert.ok(performance.now() - record.at < 8_000, "deadline recovery is bounded");
    assert.deepEqual(f.parsed, [], "incomplete bodies never reached decoding/publication");
    assert.equal((await f.send("session-c")).status, 201);
    assert.equal((await f.send("session-a")).status, 201);
    assert.deepEqual(f.published, ["session-c", "session-a"]);
  } finally { clearInterval(trickle); await f.close(); }
});

test("client abort releases its slot before the absolute deadline", { timeout: 10_000 }, async () => {
  const f = await fixture({ budgetMs: 4_000 });
  try {
    const a = f.start(); a.client.write(prefix);
    await f.waitAdmitted("session-a");
    a.client.destroy();
    await f.waitFinished("session-a");
    assert.equal((await f.send("session-a")).status, 201);
    assert.deepEqual(f.published, ["session-a"]);
  } finally { await f.close(); }
});

test("normal and malformed completion release admission and clear its timer/listeners", { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send("invalid")).status, 401);
    assert.equal(f.admitted.size, 0);
    assert.equal((await f.send("session-a")).status, 201);
    const completed = f.admitted.get("session-a")!;
    for (const event of ["finish", "close"] as const) {
      assert.equal(completed.listeners[event].length, 1);
      for (const listener of completed.listeners[event]) assert.ok(!completed.res.listeners(event).includes(listener));
    }
    for (const listener of completed.listeners.aborted) assert.ok(!completed.req.listeners("aborted").includes(listener));
    assert.ok(completed.req.file?.buffer.every(byte => byte === 0));
    assert.equal((await f.send("session-a", prefix)).status, 400);
    assert.equal((await f.send("session-a", body, "multipart/form-data")).status, 400);
    assert.equal((await f.send("session-a")).status, 201);
    assert.deepEqual(f.published, ["session-a", "session-a"]);
  } finally { await f.close(); }
});

test("remaining request budget bounds admission and late parser callbacks cannot publish or free a replacement", { timeout: 10_000 }, async () => {
  const f = await fixture({ budgetMs: 1_000, delayedParser: true });
  try {
    const a = f.start(); a.client.end(body);
    await f.waitAdmitted("session-a");
    if (!f.parserCallbacks.length) await once(f.events, "parser");
    const late = f.parserCallbacks.shift()!;
    assert.equal((await a.done).status, 0);
    assert.ok(performance.now() - f.admitted.get("session-a")!.at < 2_500, "the smaller remaining budget is enforced");
    assert.deepEqual(f.parsed, []);
    const replacement = f.start(); replacement.client.end(body);
    if (!f.parserCallbacks.length) await once(f.events, "parser");
    late();
    assert.deepEqual(f.parsed, [], "expired parser callback never reaches the next handler");
    assert.equal((await f.send("session-a")).status, 429, "late cleanup cannot free the replacement's slot");
    f.parserCallbacks.shift()!();
    assert.equal((await replacement.done).status, 201);
    assert.deepEqual(f.published, ["session-a"]);
  } finally { await f.close(); }
});

test("expiry while decode work settles prevents the later publication continuation", { timeout: 10_000 }, async () => {
  const workGate = deferred();
  const f = await fixture({ budgetMs: 1_000, workGate });
  try {
    const a = f.start(); a.client.end(body);
    if (!f.parsed.length) await once(f.events, "parsed:session-a");
    assert.equal((await a.done).status, 0);
    workGate.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.published, []);
    assert.equal((await f.send("session-a")).status, 201);
  } finally { await f.close(); }
});

test("an authentication continuation cannot admit a disconnected or exhausted request", { timeout: 10_000 }, async () => {
  const authGate = deferred();
  const f = await fixture({ authGate });
  try {
    const a = f.start(); a.client.write(prefix);
    await f.waitAuthenticating("session-a");
    const aborted = once(f.authenticating.get("session-a")!, "aborted");
    a.client.destroy();
    await Promise.all([a.done, aborted]);
    authGate.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.admitted.size, 0, "authentication completed after disconnect without reserving a slot");
    assert.equal((await f.send("session-a")).status, 201);
    assert.deepEqual(f.published, ["session-a"]);
  } finally { await f.close(); }
  const exhausted = await fixture({ budgetMs: 0 });
  try {
    assert.equal((await exhausted.send("session-a")).status, 503);
    assert.equal(exhausted.admitted.size, 0);
    assert.deepEqual(exhausted.parsed, []);
  } finally { await exhausted.close(); }
});
