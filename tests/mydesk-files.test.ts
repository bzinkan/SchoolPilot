import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { MYDESK_MAX_FILE_BYTES, MyDeskFileError, normalizeMyDeskFile, validateMyDeskFileMetadata } from "../src/services/mydeskFiles.js";

test("My Desk corrects image orientation, bounds the edge and removes metadata", async () => {
  const input = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "red" } })
    .jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Artist: "Private teacher", ImageDescription: "Private caption" } } }).toBuffer();
  const { bytes, contentType, sha256 } = await normalizeMyDeskFile(input, "image/jpeg");
  const result = await sharp(bytes).metadata();
  assert.equal(contentType, "image/jpeg"); assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.width, 800); assert.equal(result.height, 1600);
  assert.equal(result.exif, undefined); assert.equal(result.xmp, undefined); assert.equal(result.icc, undefined); assert.equal(result.orientation, undefined);
  assert.ok(!bytes.includes(Buffer.from("Private teacher")));
});

test("My Desk accepts PNG and WebP bytes and refuses corrupt or spoofed originals", async () => {
  for (const format of ["png", "webp"] as const) {
    const input = await sharp({ create: { width: 24, height: 12, channels: 4, background: "transparent" } }).toFormat(format).toBuffer();
    const normalized = await normalizeMyDeskFile(input, `image/${format}`);
    assert.equal((await sharp(normalized.bytes).metadata()).format, "jpeg");
    await assert.rejects(normalizeMyDeskFile(input, "image/jpeg"), (error: unknown) => error instanceof MyDeskFileError && error.code === "invalid_image");
  }
  await assert.rejects(normalizeMyDeskFile(Buffer.from("invalid image"), "image/jpeg"), MyDeskFileError);
});

test("My Desk rejects HEIC, oversized input and excessive decoded pixels", async () => {
  assert.throws(() => validateMyDeskFileMetadata("image/heic", 20), (error: unknown) => error instanceof MyDeskFileError && error.status === 415);
  assert.throws(() => validateMyDeskFileMetadata("image/png", MYDESK_MAX_FILE_BYTES + 1), (error: unknown) => error instanceof MyDeskFileError && error.status === 413);
  const input = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(normalizeMyDeskFile(input, "image/png"), MyDeskFileError);
});

test("My Desk validates PDFs separately and preserves their exact bytes", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  const bytes = Buffer.from(await pdf.save());
  const result = await normalizeMyDeskFile(bytes, "application/pdf");
  assert.deepEqual(result.bytes, bytes); assert.equal(result.contentType, "application/pdf");
  await assert.rejects(normalizeMyDeskFile(Buffer.from("%PDF-1.7\nnot a document\n%%EOF"), "application/pdf"), (error: unknown) => error instanceof MyDeskFileError && error.code === "invalid_pdf");
});
