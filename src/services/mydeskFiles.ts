import { createHash } from "node:crypto";
import sharp from "sharp";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { inspectPrivatePdf, PrivatePdfError } from "./privatePdfProcessing.js";
import { privateNativeProcessing, PrivateNativeProcessingError } from "./privateNativeProcessing.js";

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

export function validateMyDeskFileMetadata(contentType: string, size: number): asserts contentType is MyDeskFileType {
  if (!MYDESK_FILE_TYPES.includes(contentType as MyDeskFileType)) {
    throw new MyDeskFileError(415, "unsupported_file_type", "Choose a JPEG, PNG, WebP image or PDF. Convert HEIC/HEIF photos to JPEG first.");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MYDESK_MAX_FILE_BYTES) {
    throw new MyDeskFileError(413, "file_too_large", "Each file must be nonempty and no larger than 10 MiB.");
  }
}

/** Decode actual bytes, not a filename or browser MIME assertion. Never retain an undecodable original. */
export async function normalizeMyDeskFile(bytes: Buffer, contentType: string, options: { signal?: AbortSignal } = {}): Promise<{ bytes: Buffer; contentType: MyDeskFileType; sha256: string }> {
  validateMyDeskFileMetadata(contentType, bytes.length);
  if (contentType === "application/pdf") {
    try {
      await inspectPrivatePdf(bytes, { maxPages: 1000, signal: options.signal });
    } catch (error) {
      if (error instanceof PrivatePdfError && error.retryable) {
        throw new MyDeskFileError(503, "pdf_processing_unavailable", "PDF processing is temporarily unavailable. Please retry your upload.");
      }
      throw new MyDeskFileError(422, "invalid_pdf", "The PDF could not be read. Choose a valid, unencrypted PDF with at most 1,000 pages.");
    }
    // Preserve the original PDF bytes, including document signatures.
    return { bytes, contentType, sha256: myDeskSha256(bytes) };
  }
  try {
    const normalized = await privateNativeProcessing.run(async () => {
      const input = sharp(bytes, { limitInputPixels: 24_000_000, failOn: "warning", animated: false });
      const metadata = await input.metadata();
      const expected = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[contentType];
      if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("format_mismatch");
      return input.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).jpeg({ quality: 85, mozjpeg: true }).timeout({ seconds: 15 }).toBuffer();
    }, options);
    // sharp strips EXIF/XMP/IPTC/ICC by default; do not call withMetadata or keepMetadata.
    return { bytes: normalized, contentType: "image/jpeg", sha256: myDeskSha256(normalized) };
  } catch (error) {
    if (error instanceof PrivateNativeProcessingError) {
      throw new MyDeskFileError(503, "image_processing_unavailable", "Image processing is temporarily unavailable. Please retry your upload.");
    }
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
