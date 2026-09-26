import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { createPrivatePdfProcessor, PrivatePdfError } from "../src/services/privatePdfProcessing.js";
import { createPrivateNativeProcessing, privateNativeProcessing, PrivateNativeProcessingError } from "../src/services/privateNativeProcessing.js";
import { MyDeskFileError, normalizeMyDeskFile } from "../src/services/mydeskFiles.js";

const source = Buffer.from("%PDF-1.7\nPRIVATE_DOCUMENT_CANARY\n%%EOF");
const metadata = "Title: PRIVATE_METADATA_CANARY\nPages: 2\nEncrypted: no\n";
const errorCode = (code: string) => (error: unknown) => error instanceof PrivatePdfError && error.code === code &&
  !String(error.stack).includes("PRIVATE");
type Invocation = { command: string; args: string[]; options: SpawnOptions; child: ChildProcess; kills: (NodeJS.Signals | number | undefined)[] };

function harness() {
  const calls: Invocation[] = [];
  const awaiting = new Map<number, (call: Invocation) => void>();
  const spawnChild = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    const child = new ChildProcess(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const kills: Invocation["kills"] = [];
    child.kill = signal => { kills.push(signal); return true; };
    const call = { command, args, options, child, kills }; calls.push(call);
    awaiting.get(calls.length - 1)?.(call);
    return child;
  };
  const started = async (index: number): Promise<Invocation> => {
    const existing = calls[index]; if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Expected bounded PDF child to start")), 2000);
      awaiting.set(index, call => { clearTimeout(timer); awaiting.delete(index); resolve(call); });
    });
  };
  const finish = (call: Invocation, output = metadata, code = 0) => {
    call.child.stdout?.emit("data", Buffer.from(output)); call.child.emit("close", code, null);
  };
  return { calls, spawnChild, started, finish };
}

test("shared PDF inspector uses fixed bounded Linux tools, private temporary files, and returns only safe metadata", async () => {
  const fixture = harness(); const processor = createPrivatePdfProcessor({ spawnChild: fixture.spawnChild, platform: "linux" });
  const original = process.env.PDF_PRIVATE_TEST_SECRET; process.env.PDF_PRIVATE_TEST_SECRET = "PRIVATE_SECRET_CANARY";
  try {
    const operation = processor.inspect(source, { maxPages: 20 }); const call = await fixture.started(0);
    assert.equal(call.command, "/usr/bin/prlimit");
    assert.deepEqual(call.args.slice(0, 6), ["--as=536870912", "--cpu=30", "--fsize=16777216", "--nofile=64", "--", "/usr/bin/pdfinfo"]);
    assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.deepEqual(Object.keys(call.options.env!).sort(), ["LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR"]);
    assert.equal(call.options.env!.PATH, "/usr/bin:/bin");
    assert.equal(JSON.stringify(call.options).includes("PRIVATE"), false);
    const input = call.args.at(-1)!; assert.deepEqual(await readFile(input), source);
    fixture.finish(call); assert.deepEqual(await operation, { pageCount: 2 });
    await assert.rejects(access(input));
  } finally {
    if (original === undefined) delete process.env.PDF_PRIVATE_TEST_SECRET; else process.env.PDF_PRIVATE_TEST_SECRET = original;
  }
});

test("inspection rejects missing, duplicate, encrypted and out-of-bound page metadata without disclosing it", async () => {
  const fixture = harness(); const processor = createPrivatePdfProcessor({ spawnChild: fixture.spawnChild });
  const cases = [
    ["Title: PRIVATE\nPages: 2\n", "invalid_pdf"],
    ["Pages: 2\nPages: 9\nEncrypted: no\n", "invalid_pdf"],
    ["Pages: 2\nEncrypted: yes (PRIVATE)\n", "invalid_pdf"],
    ["Pages: 2\nEncrypted: no\nEncrypted: no\n", "invalid_pdf"],
    ["Pages: 0\nEncrypted: no\n", "invalid_pdf"],
    ["Pages: 9007199254740992\nEncrypted: no\n", "invalid_pdf"],
    ["Pages: 21\nEncrypted: no\n", "pdf_page_limit"],
  ];
  for (const [index, [output, code]] of cases.entries()) {
    const operation = processor.inspect(source, { maxPages: 20 }); const rejected = assert.rejects(operation, errorCode(code!));
    const call = await fixture.started(index); fixture.finish(call, output); await rejected;
    await assert.rejects(access(call.args.at(-1)!));
  }
  await assert.rejects(processor.inspect(Buffer.from("PRIVATE invalid input"), { maxPages: 20 }), errorCode("invalid_pdf"));
  assert.equal(fixture.calls.length, cases.length);
});

test("inspection and rendering share one FIFO permit, with four queued calls and rejection beyond that bound", async () => {
  const fixture = harness(); const processor = createPrivatePdfProcessor({ spawnChild: fixture.spawnChild });
  const operations: Promise<unknown>[] = [processor.inspect(source, { maxPages: 1000 })];
  const first = await fixture.started(0);
  operations.push(processor.renderPage({ source: "/private/source.pdf", outputPrefix: "/private/page", page: 1, maxEdge: 4096, timeoutMs: 1000 }));
  for (let i = 0; i < 3; i++) operations.push(processor.inspect(source, { maxPages: 20 }));
  await assert.rejects(processor.inspect(source, { maxPages: 20 }), errorCode("pdf_busy"));
  assert.equal(fixture.calls.length, 1);
  fixture.finish(first);
  for (let index = 1; index < operations.length; index++) {
    const call = await fixture.started(index);
    if (index === 1) assert.ok(call.args.includes("/private/page"));
    assert.equal(fixture.calls.length, index + 1); fixture.finish(call);
  }
  await Promise.all(operations);
});

test("cancelled queued calls are removed and waiting expires without spawning another process", async () => {
  const fixture = harness(); const processor = createPrivatePdfProcessor({ spawnChild: fixture.spawnChild, waitMs: 20 });
  const running = processor.inspect(source, { maxPages: 20 }); const first = await fixture.started(0);
  const controller = new AbortController();
  const cancelled = assert.rejects(processor.inspect(source, { maxPages: 20, signal: controller.signal }), errorCode("pdf_aborted"));
  controller.abort(); await cancelled;
  await assert.rejects(processor.inspect(source, { maxPages: 20 }), errorCode("pdf_busy"));
  assert.equal(fixture.calls.length, 1);
  fixture.finish(first); await running;
  const next = processor.inspect(source, { maxPages: 20 }); fixture.finish(await fixture.started(1)); await next;
});

test("active abort holds its permit and temporary source until the native process has actually closed", async () => {
  const fixture = harness(); const processor = createPrivatePdfProcessor({ spawnChild: fixture.spawnChild });
  const controller = new AbortController(); let settled = false;
  const running = processor.inspect(source, { maxPages: 20, signal: controller.signal });
  void running.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(running, errorCode("pdf_aborted")); const first = await fixture.started(0);
  const queued = processor.inspect(source, { maxPages: 1000 });
  controller.abort(); await delay(10);
  assert.deepEqual(first.kills, ["SIGKILL"]); assert.equal(settled, false); assert.equal(fixture.calls.length, 1);
  assert.deepEqual(await readFile(first.args.at(-1)!), source);
  fixture.finish(first); await rejected;
  await assert.rejects(access(first.args.at(-1)!));
  fixture.finish(await fixture.started(1)); await queued;
});

test("combined stdout/stderr limit kills the child and suppresses private output and process errors", async () => {
  const fixture = harness(); const processor = createPrivatePdfProcessor({ spawnChild: fixture.spawnChild });
  const operation = processor.inspect(source, { maxPages: 20 }); const rejected = assert.rejects(operation, errorCode("invalid_pdf"));
  const call = await fixture.started(0);
  call.child.stdout?.emit("data", Buffer.alloc(4096, "x"));
  call.child.stderr?.emit("data", Buffer.alloc(4097, "y"));
  assert.deepEqual(call.kills, ["SIGKILL"]);
  fixture.finish(call, "PRIVATE parser details", 1); await rejected;
  const unavailable = processor.inspect(source, { maxPages: 20 }); const unavailableResult = assert.rejects(unavailable, errorCode("pdf_unavailable"));
  const failed = await fixture.started(1); failed.child.emit("error", new Error("PRIVATE executable failure"));
  failed.child.emit("close", -1, null); await unavailableResult;
  await assert.rejects(access(failed.args.at(-1)!));
  const missingTool = processor.inspect(source, { maxPages: 20 });
  const missingToolResult = assert.rejects(missingTool, errorCode("pdf_unavailable"));
  fixture.finish(await fixture.started(2), "PRIVATE missing executable", 127); await missingToolResult;
  const missing = createPrivatePdfProcessor({ spawnChild: () => { throw new Error("PRIVATE command failure"); } });
  await assert.rejects(missing.inspect(source, { maxPages: 20 }), errorCode("pdf_unavailable"));
});

test("wall timeout kills a real child, waits for close, and leaves the permit usable", async () => {
  let closed = 0;
  const processor = createPrivatePdfProcessor({ spawnChild: (_command, _args, options) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    child.once("close", () => { closed++; }); return child;
  } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(processor.renderPage({ source: process.execPath, outputPrefix: "unused", page: 1, maxEdge: 4096, timeoutMs: 50 }), errorCode("pdf_timeout"));
    assert.equal(closed, attempt + 1);
  }
});

test("PDF and real image normalization share FIFO capacity, remove cancelled image waiters and reject overflow safely", async () => {
  const fixture = harness();
  const processor = createPrivatePdfProcessor({ spawnChild: fixture.spawnChild, nativeProcessing: privateNativeProcessing });
  const photo = await sharp({ create: { width: 48, height: 24, channels: 3, background: "red" } }).jpeg().toBuffer();
  const retryableImage = (error: unknown) => error instanceof MyDeskFileError && error.status === 503 &&
    error.code === "image_processing_unavailable" && !String(error.stack).includes("PRIVATE");
  const running = processor.inspect(source, { maxPages: 20 }); const first = await fixture.started(0);
  const controller = new AbortController();
  const cancelled = assert.rejects(normalizeMyDeskFile(photo, "image/jpeg", { signal: controller.signal }), retryableImage);
  controller.abort(new Error("PRIVATE cancellation reason")); await cancelled;
  let imageDone = false;
  const image = normalizeMyDeskFile(photo, "image/jpeg").then(result => { imageDone = true; return result; });
  const pdf = processor.inspect(source, { maxPages: 20 });
  const images = [normalizeMyDeskFile(photo, "image/jpeg"), normalizeMyDeskFile(photo, "image/jpeg")];
  await assert.rejects(normalizeMyDeskFile(photo, "image/jpeg"), retryableImage);
  assert.equal(imageDone, false); assert.equal(fixture.calls.length, 1);
  fixture.finish(first); await running;
  const second = await fixture.started(1);
  assert.equal(imageDone, true, "the earlier Sharp pipeline must finish before the next PDF child starts");
  fixture.finish(second); await pdf;
  for (const result of await Promise.all([image, ...images])) assert.equal((await sharp(result.bytes).metadata()).format, "jpeg");
});

test("active image cancellation holds the shared permit until native completion and releases after timeouts and failures", async () => {
  const native = createPrivateNativeProcessing({ waitMs: 1000 });
  const fixture = harness();
  const processor = createPrivatePdfProcessor({ spawnChild: fixture.spawnChild, nativeProcessing: native });
  const controller = new AbortController();
  let complete!: () => void, started!: () => void, settled = false;
  const nativeFinished = new Promise<void>(resolve => { complete = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const image = native.run(async () => {
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: "white" } }).jpeg().timeout({ seconds: 15 }).toBuffer();
    started(); await nativeFinished; return bytes;
  }, { signal: controller.signal });
  void image.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(image, (error: unknown) => error instanceof PrivateNativeProcessingError && error.code === "aborted" && !String(error.stack).includes("PRIVATE"));
  await entered;
  const queued = processor.inspect(source, { maxPages: 20 });
  controller.abort(new Error("PRIVATE image content")); await delay(10);
  assert.equal(settled, false); assert.equal(fixture.calls.length, 0);
  complete(); await rejected;
  fixture.finish(await fixture.started(0)); await queued;
  await assert.rejects(native.run(async () => { throw new Error("timeout: 12% complete\nPRIVATE native content"); }),
    (error: unknown) => error instanceof PrivateNativeProcessingError && error.code === "timeout" && !String(error.stack).includes("PRIVATE"));
  await assert.rejects(native.run(async () => { throw new Error("test operation failure"); }), /test operation failure/);
  assert.equal(await native.run(async () => "next operation"), "next operation");
});
