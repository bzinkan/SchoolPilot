import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const MYDESK_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MYDESK_MAX_ATTACHMENTS = 5;
export const MYDESK_UPLOAD_LEASE_MS = 2 * 60_000;
export const MYDESK_CLEANUP_GRACE_MS = 60_000;
export const MYDESK_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type MyDeskFileType = typeof MYDESK_FILE_TYPES[number];

export class MyDeskFileError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const myDeskSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function validatePdf(bytes: Buffer): Promise<void> {
  // A malformed PDF must not monopolize the API event loop, expand an unbounded heap,
  // or write parser warnings containing document values to application logs.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { PDFDocument } = require('pdf-lib');
    (async () => {
      try {
        const document = await PDFDocument.load(workerData, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
        const pages = document.getPageCount();
        parentPort.postMessage(pages > 0 && pages <= 1000);
      } catch { parentPort.postMessage(false); }
    })();
  `, { eval: true, execArgv: [], workerData: bytes, stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  worker.stdout.resume(); worker.stderr.resume();
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const invalid = () => reject(new Error("invalid_pdf"));
      timer = setTimeout(invalid, 15_000);
      worker.once("message", valid => valid === true ? resolve() : invalid());
      worker.once("error", invalid);
      worker.once("exit", invalid);
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}

export function validateMyDeskFileMetadata(contentType: string, size: number): asserts contentType is MyDeskFileType {
  if (!MYDESK_FILE_TYPES.includes(contentType as MyDeskFileType)) {
    throw new MyDeskFileError(415, "unsupported_file_type", "Choose a JPEG, PNG, WebP image or PDF. Convert HEIC/HEIF photos to JPEG first.");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MYDESK_MAX_FILE_BYTES) {
    throw new MyDeskFileError(413, "file_too_large", "Each file must be nonempty and no larger than 10 MiB.");
  }
}

/** Decode actual bytes, not a filename or browser MIME assertion. Never retain an undecodable original. */
export async function normalizeMyDeskFile(bytes: Buffer, contentType: string): Promise<{ bytes: Buffer; contentType: MyDeskFileType; sha256: string }> {
  validateMyDeskFileMetadata(contentType, bytes.length);
  if (contentType === "application/pdf") {
    if (!bytes.subarray(0, 8).toString("ascii").match(/^%PDF-1\.[0-9]|^%PDF-2\.0/) ||
      !bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1").includes("%%EOF")) {
      throw new MyDeskFileError(422, "invalid_pdf", "This file is not a valid PDF.");
    }
    try {
      await validatePdf(bytes);
    } catch {
      throw new MyDeskFileError(422, "invalid_pdf", "The PDF could not be read. Choose a valid, unencrypted PDF with at most 1,000 pages.");
    }
    // Preserve the original PDF bytes, including document signatures.
    return { bytes, contentType, sha256: myDeskSha256(bytes) };
  }
  try {
    const input = sharp(bytes, { limitInputPixels: 24_000_000, failOn: "warning", animated: false });
    const metadata = await input.metadata();
    const expected = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[contentType];
    if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("format_mismatch");
    const normalized = await input.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 85, mozjpeg: true }).timeout({ seconds: 15 }).toBuffer();
    // sharp strips EXIF/XMP/IPTC/ICC by default; do not call withMetadata or keepMetadata.
    return { bytes: normalized, contentType: "image/jpeg", sha256: myDeskSha256(normalized) };
  } catch {
    throw new MyDeskFileError(422, "invalid_image", "This image could not be read. Choose a single JPEG, PNG or WebP image no larger than 24 megapixels.");
  }
}

export interface MyDeskObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

let s3Client: S3Client | undefined;
function bucket(): string {
  const name = process.env.MYDESK_ATTACHMENTS_BUCKET?.trim();
  if (!name) throw new MyDeskFileError(503, "attachments_unavailable", "Attachments are temporarily unavailable. Your note can still be saved without files.");
  return name;
}
function client(): S3Client { return s3Client ??= new S3Client({ region: process.env.AWS_REGION || "us-east-1", maxAttempts: 2 }); }

export const myDeskObjectStore: MyDeskObjectStore = {
  async put(key, bytes, contentType) {
    await client().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: bytes, ContentType: contentType,
      ServerSideEncryption: "AES256", CacheControl: "private, no-store" }), { abortSignal: AbortSignal.timeout(45_000) });
  },
  async get(key) {
    const result = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
    if (!result.Body || (result.ContentLength ?? 0) > MYDESK_MAX_FILE_BYTES) throw new MyDeskFileError(503, "attachment_unavailable", "This attachment is temporarily unavailable.");
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    if (bytes.length > MYDESK_MAX_FILE_BYTES) throw new MyDeskFileError(503, "attachment_unavailable", "This attachment is temporarily unavailable.");
    return bytes;
  },
  async delete(key) {
    await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
  },
};
