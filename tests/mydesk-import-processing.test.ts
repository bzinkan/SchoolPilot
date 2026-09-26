import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { PDFDocument, rgb } from "pdf-lib";
import {
  buildImportAttachment, createImportAiProcessor, createImportProviderTransport, cropImportRegion, importExtractionSchema,
  MyDeskImportProcessingError, prepareImportSource, renderImportSource, type ImportAiTransport,
} from "../src/services/mydeskImportProcessing.js";
import { MyDeskFileError } from "../src/services/mydeskFiles.js";
import { privateNativeProcessing } from "../src/services/privateNativeProcessing.js";

const photo = (width = 160, height = 100, color = "white") => sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
const full = { x: 0, y: 0, width: 1, height: 1 };
const extraction = { subjectNames: ["Jordan Example"], entryDate: "2026-09-25", category: "detention", title: "Detention form",
  body: "The form reports a classroom disruption. A detention was assigned.", warnings: [] };
const response = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], stop_reason: "end_turn" });

test("all import image paths use the shared bounded permit and release it before provider calls", async () => {
  const bytes = await photo();
  const controller = new AbortController();
  const release = await privateNativeProcessing.acquire();
  let providerCalls = 0;
  const retryable = (error: unknown) => error instanceof MyDeskImportProcessingError && error.retryable && error.status === 503 &&
    error.code === "MYDESK_IMPORT_IMAGE_UNAVAILABLE" && !String(error.stack).includes("PRIVATE");
  const queued = [
    assert.rejects(prepareImportSource(bytes, "image/jpeg", { signal: controller.signal }), retryable),
    assert.rejects(renderImportSource(bytes, "image/jpeg", { signal: controller.signal }), retryable),
    assert.rejects(cropImportRegion({ bytes, region: full, rotation: 0 }, { signal: controller.signal }), retryable),
    assert.rejects(buildImportAttachment([{ bytes, region: full, rotation: 0 }], { signal: controller.signal }), retryable),
  ];
  try {
    const ai = createImportAiProcessor(async () => { providerCalls++; return response(extraction); });
    await assert.rejects(ai.extractImportForm([bytes]), retryable);
    assert.equal(providerCalls, 0, "capacity rejection must occur before any paid provider call");
    controller.abort(new Error("PRIVATE queued image content")); await Promise.all(queued);
  } finally { controller.abort(); release(); }
  const ai = createImportAiProcessor(async () => {
    // A provider request must not occupy native capacity during its network wait.
    assert.equal(await privateNativeProcessing.run(async () => "available"), "available");
    providerCalls++; return response(extraction);
  });
  assert.deepEqual(await ai.extractImportForm([bytes]), extraction);
  assert.equal(providerCalls, 1);
  assert.ok((await cropImportRegion({ bytes, region: full, rotation: 90 })).length > 0, "crop then normalization must not deadlock");
});

test("import preserves splitting resolution, corrects EXIF orientation and strips private metadata", async () => {
  const input = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "white" } })
    .jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Artist: "PRIVATE STAFF", ImageDescription: "PRIVATE CONTENT" } } }).toBuffer();
  const prepared = await prepareImportSource(input, "image/jpeg");
  const metadata = await sharp(prepared.bytes).metadata();
  assert.equal(prepared.pageCount, 1); assert.equal(metadata.width, 2000); assert.equal(metadata.height, 3000);
  assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.equal(metadata.xmp, undefined);
  assert.ok(!prepared.bytes.includes(Buffer.from("PRIVATE")));
  const bounded = await prepareImportSource(await photo(6000, 4000), "image/jpeg");
  const boundedMetadata = await sharp(bounded.bytes).metadata();
  assert.ok(boundedMetadata.width! <= 4096); assert.ok(boundedMetadata.width! * boundedMetadata.height! <= 12_000_000);
});

test("import rejects unsupported, corrupt, spoofed, oversized, and excessive-pixel inputs", async () => {
  await assert.rejects(prepareImportSource(Buffer.from("private payload"), "image/heic"), MyDeskFileError);
  await assert.rejects(prepareImportSource(Buffer.alloc(10 * 1024 * 1024 + 1), "image/jpeg"), MyDeskFileError);
  await assert.rejects(prepareImportSource(Buffer.from("private bad image"), "image/jpeg"), MyDeskImportProcessingError);
  const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: "white" } }).png().toBuffer();
  await assert.rejects(prepareImportSource(png, "image/jpeg"), MyDeskImportProcessingError);
  await assert.rejects(prepareImportSource(await photo(5000, 5000), "image/jpeg"), MyDeskImportProcessingError);
  for (const format of ["png", "webp"] as const) {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    assert.equal((await prepareImportSource(bytes, `image/${format}`)).contentType, "image/jpeg");
  }
});

test("import PDF validation preserves original bytes but rejects empty, oversized-page-count and invalid documents", async () => {
  const document = await PDFDocument.create(); document.addPage([200, 100]); document.setTitle("PRIVATE SOURCE TITLE");
  const bytes = Buffer.from(await document.save());
  assert.deepEqual((await prepareImportSource(bytes, "application/pdf")).bytes, bytes);
  const tooMany = await PDFDocument.create(); for (let i = 0; i < 21; i++) tooMany.addPage();
  await assert.rejects(prepareImportSource(Buffer.from(await tooMany.save()), "application/pdf"),
    (error: unknown) => error instanceof MyDeskImportProcessingError && error.code === "MYDESK_IMPORT_PAGE_LIMIT");
  tooMany.removePage(20);
  assert.equal((await prepareImportSource(Buffer.from(await tooMany.save()), "application/pdf")).pageCount, 20);
  await assert.rejects(prepareImportSource(Buffer.from("%PDF-1.7\nPRIVATE DATA\n%%EOF"), "application/pdf"),
    (error: unknown) => error instanceof MyDeskImportProcessingError && !error.message.includes("PRIVATE"));
});

test("cancelled import PDF processing stays retryable and never discloses cancellation reasons", async () => {
  const document = await PDFDocument.create(); document.addPage();
  const controller = new AbortController(); controller.abort(new Error("PRIVATE source details"));
  await assert.rejects(prepareImportSource(Buffer.from(await document.save()), "application/pdf", { signal: controller.signal }),
    (error: unknown) => error instanceof MyDeskImportProcessingError && error.retryable && error.status === 503 && !String(error.stack).includes("PRIVATE"));
});

test("PDF validation rejects encryption even when the document opens without a password", async () => {
  // Synthetic blank page produced with pypdf 6.16, empty user password, RC4-128 encryption.
  const encoded = await readFile(new URL("./fixtures/mydesk-import-encrypted-empty-password.pdf.base64", import.meta.url), "utf8");
  await assert.rejects(prepareImportSource(Buffer.from(encoded.trim(), "base64"), "application/pdf"),
    (error: unknown) => error instanceof MyDeskImportProcessingError && error.code === "MYDESK_IMPORT_INVALID_PDF");
});

test("deterministic crops exclude neighboring form pixels and apply rotation before cropping", async () => {
  const red = await photo(200, 100, "red"); const blue = await photo(200, 100, "blue");
  const page = await sharp({ create: { width: 200, height: 200, channels: 3, background: "white" } })
    .composite([{ input: red, left: 0, top: 0 }, { input: blue, left: 0, top: 100 }]).jpeg().toBuffer();
  const first = await cropImportRegion({ bytes: page, region: { x: 0, y: 0, width: 1, height: 0.45 }, rotation: 0 });
  const stats = await sharp(first).stats(); assert.ok(stats.channels[0]!.mean > 240); assert.ok(stats.channels[2]!.mean < 20);
  const rotated = await cropImportRegion({ bytes: page, region: { x: 0.55, y: 0, width: 0.45, height: 1 }, rotation: 90 });
  const rotatedStats = await sharp(rotated).stats(); assert.ok(rotatedStats.channels[0]!.mean > 240); assert.ok(rotatedStats.channels[2]!.mean < 20);
  await assert.rejects(cropImportRegion({ bytes: page, region: { x: 0.9, y: 0, width: 0.2, height: 1 }, rotation: 0 }), MyDeskImportProcessingError);
  await assert.rejects(cropImportRegion({ bytes: page, region: { x: 0, y: 0, width: 0, height: 1 }, rotation: 0 }), MyDeskImportProcessingError);
});

test("single regions become normalized photos and continuation regions become a new image-only PDF", async () => {
  const bytes = await photo(2000, 1000, "green");
  const single = await buildImportAttachment([{ bytes, region: full, rotation: 0 }]);
  assert.equal(single.contentType, "image/jpeg"); assert.match(single.sha256, /^[0-9a-f]{64}$/);
  assert.equal((await sharp(single.bytes).metadata()).width, 1600);
  const joined = await buildImportAttachment([{ bytes, region: full, rotation: 0 }, { bytes, region: full, rotation: 90 }]);
  assert.equal(joined.contentType, "application/pdf");
  const pdf = await PDFDocument.load(joined.bytes, { updateMetadata: false }); assert.equal(pdf.getPageCount(), 2); assert.equal(pdf.getAuthor(), "");
  assert.equal(pdf.getCreationDate()?.getTime(), 0); assert.equal(pdf.getModificationDate()?.getTime(), 0);
  assert.deepEqual((await buildImportAttachment([{ bytes, region: full, rotation: 0 }, { bytes, region: full, rotation: 90 }])).bytes, joined.bytes);
  assert.equal(pdf.getPages()[0]!.getWidth(), 1600); assert.equal(pdf.getPages()[1]!.getWidth(), 800);
  await assert.rejects(buildImportAttachment([]), MyDeskImportProcessingError);
});

test("tool-free AI extraction sends only source images and returns unknown dates for manual review", async () => {
  let observed = 0;
  const transport: ImportAiTransport = async (request, signal) => {
    observed++; assert.equal(request.model, "fixture-model"); assert.equal(request.tools, undefined);
    assert.equal(request.output_config?.format?.type, "json_schema");
    assert.equal(signal.aborted, false); assert.ok(String(request.system).includes("untrusted source data"));
    assert.ok(!JSON.stringify(request).includes("cache_control")); assert.ok(!JSON.stringify(request).includes("file_id"));
    assert.ok(!JSON.stringify(request).includes("PRIVATE STAFF"));
    return response({ ...extraction, subjectNames: [], entryDate: null });
  };
  const ai = createImportAiProcessor(transport, { model: "fixture-model" });
  const result = await ai.extractImportForm([await photo()]);
  assert.equal(observed, 1); assert.equal(result.entryDate, null);
  assert.deepEqual(result.subjectNames, []); assert.ok(result.warnings.includes("uncertain_date")); assert.ok(result.warnings.includes("uncertain_subject"));
});

test("AI outputs are bounded and cannot supply ownership, target IDs or arbitrary warning text", async () => {
  const bytes = await photo();
  for (const invalid of [
    { ...extraction, schoolId: "other-school" }, { ...extraction, studentId: "untrusted-id" },
    { ...extraction, warnings: ["SECRET DOCUMENT CONTENT"] }, { ...extraction, entryDate: "2026-02-30" },
    { ...extraction, body: "x".repeat(5001) },
  ]) {
    await assert.rejects(createImportAiProcessor(async () => response(invalid)).extractImportForm([bytes]),
      (error: unknown) => error instanceof MyDeskImportProcessingError && error.code === "MYDESK_IMPORT_AI_INVALID" && !error.message.includes("SECRET"));
  }
  assert.equal(importExtractionSchema.safeParse(extraction).success, true);
  const multi = await createImportAiProcessor(async () => response({ ...extraction, subjectNames: ["A Example", "B Example"] })).extractImportForm([bytes]);
  assert.ok(multi.warnings.includes("multiple_subjects"));
});

test("AI detection accepts separate regions but never silently truncates overflow or trusts out-of-page coordinates", async () => {
  const bytes = await photo();
  const regions = [{ x: 0, y: 0, width: 1, height: 0.45 }, { x: 0, y: 0.55, width: 1, height: 0.45 }];
  assert.deepEqual(await createImportAiProcessor(async () => response({ regions })).detectImportForms(bytes), regions);
  for (const invalid of [{ regions: Array(51).fill(full) }, { regions: [{ ...full, x: 0.1 }] }, { regions: [{ ...full, width: -1 }] }]) {
    await assert.rejects(createImportAiProcessor(async () => response(invalid)).detectImportForms(bytes), MyDeskImportProcessingError);
  }
  assert.deepEqual(await createImportAiProcessor(async () => response({ regions: [] })).detectImportForms(bytes), []);
});

test("provider truncation, refusals and malformed output remain retryable and private", async () => {
  const bytes = await photo();
  for (const result of [
    { ...response(extraction), stop_reason: "max_tokens" },
    { ...response(extraction), stop_reason: "refusal" },
    { content: [{ type: "tool_use", name: "save_note", input: extraction }], stop_reason: "end_turn" },
    { content: [{ type: "text", text: "PRIVATE provider failure" }], stop_reason: "end_turn" },
  ]) {
    await assert.rejects(createImportAiProcessor(async () => result).extractImportForm([bytes]),
      (error: unknown) => error instanceof MyDeskImportProcessingError && error.retryable && !error.message.includes("PRIVATE"));
  }
  await assert.rejects(createImportAiProcessor(async () => { throw new Error("PRIVATE request body and key"); }).extractImportForm([bytes]),
    (error: unknown) => error instanceof MyDeskImportProcessingError && error.code === "MYDESK_IMPORT_AI_FAILED" && !error.stack?.includes("PRIVATE"));
});

test("provider timeout aborts the request without waiting on an uncooperative transport", async () => {
  let signal: AbortSignal | undefined;
  const ai = createImportAiProcessor((_request, received) => { signal = received; return new Promise(() => {}); }, { timeoutMs: 10 });
  await assert.rejects(ai.extractImportForm([await photo()]),
    (error: unknown) => error instanceof MyDeskImportProcessingError && error.code === "MYDESK_IMPORT_AI_TIMEOUT");
  assert.equal(signal?.aborted, true);
});

test("dedicated SDK transport suppresses inherited debug logging of private request and response bodies", async () => {
  const originalLevel = process.env.ANTHROPIC_LOG;
  process.env.ANTHROPIC_LOG = "debug";
  const captured: unknown[][] = [];
  const originalConsole = { log: console.log, debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  for (const method of ["log", "debug", "info", "warn", "error"] as const) console[method] = (...values: unknown[]) => { captured.push(values); };
  try {
    let calls = 0;
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      calls++; assert.ok(String(init?.body).includes("PRIVATE_REQUEST_CANARY"));
      return new Response(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model",
        content: [{ type: "text", text: "PRIVATE_RESPONSE_CANARY" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "fixture" } });
    };
    const transport = createImportProviderTransport("fixture-api-key", fakeFetch);
    await transport({ model: "fixture-model", max_tokens: 20, messages: [{ role: "user", content: "PRIVATE_REQUEST_CANARY" }] }, new AbortController().signal);
    assert.equal(calls, 1); assert.deepEqual(captured, []);
  } finally {
    Object.assign(console, originalConsole);
    if (originalLevel === undefined) delete process.env.ANTHROPIC_LOG; else process.env.ANTHROPIC_LOG = originalLevel;
  }
});

test("real Poppler renderer produces source-isolated page images", async () => {
  const pdf = await PDFDocument.create(); const first = pdf.addPage([200, 100]); first.drawRectangle({ x: 0, y: 0, width: 200, height: 100, color: rgb(1, 0, 0) });
  const second = pdf.addPage([100, 200]); second.drawRectangle({ x: 0, y: 0, width: 100, height: 200, color: rgb(0, 0, 1) });
  pdf.setTitle("PRIVATE ORIGINAL METADATA");
  const pages = await renderImportSource(Buffer.from(await pdf.save()), "application/pdf");
  assert.equal(pages.length, 2); assert.equal(pages[0]!.pageNumber, 1); assert.equal(pages[1]!.pageNumber, 2);
  assert.ok(pages[0]!.width > pages[0]!.height); assert.ok(pages[1]!.width < pages[1]!.height);
  assert.ok((await sharp(pages[0]!.bytes).stats()).channels[0]!.mean > 240);
  assert.ok((await sharp(pages[1]!.bytes).stats()).channels[2]!.mean > 240);
  for (const page of pages) { assert.equal((await sharp(page.bytes).metadata()).exif, undefined); assert.ok(!page.bytes.includes(Buffer.from("PRIVATE"))); }
});
