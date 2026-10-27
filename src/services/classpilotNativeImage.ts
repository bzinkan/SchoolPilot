import sharp from "sharp";
import { ClasspilotNativeError, NATIVE_LIMITS } from "./classpilotNativeProtocol.js";

/** Decode a bounded JPEG and strip all metadata. No filenames or disk buffers. */
export async function normalizeClasspilotNativeJpeg(input: Buffer): Promise<Buffer> {
  if (input.length < 4 || input.length > NATIVE_LIMITS.maxBytes || input[0] !== 0xff || input[1] !== 0xd8) {
    throw new ClasspilotNativeError("NATIVE_INVALID_OBSERVATION", 400, "Upload one bounded JPEG image.");
  }
  try {
    const decoder = sharp(input, { limitInputPixels: NATIVE_LIMITS.maxWidth * NATIVE_LIMITS.maxHeight, failOn: "warning" });
    const metadata = await decoder.metadata();
    if (metadata.format !== "jpeg" || !metadata.width || !metadata.height || metadata.width > NATIVE_LIMITS.maxWidth
      || metadata.height > NATIVE_LIMITS.maxHeight || (metadata.pages ?? 1) !== 1) throw new Error("Unsupported image");
    const result = await decoder.jpeg({ quality: 70 }).toBuffer();
    if (result.length > NATIVE_LIMITS.maxBytes) throw new Error("Image exceeds budget");
    return result;
  } catch {
    throw new ClasspilotNativeError("NATIVE_INVALID_OBSERVATION", 400, "The JPEG image is invalid or exceeds the thumbnail limits.");
  }
}
