import type { Request, Response } from "express";
import { gzip } from "node:zlib";

type Options = {
  maxConcurrent?: number; timeoutMs?: number; minBytes?: number; maxBytes?: number;
  compress?: (input: Buffer) => Promise<Buffer>;
};
type ScreenshotBody = { tiles: unknown[]; screenshotStore?: "unavailable" };
type Prepared = { body: ScreenshotBody; json: string; compressed?: Buffer };

export function createScreenshotResponseEncoder(options: Options = {}) {
  const maxConcurrent = options.maxConcurrent ?? 2;
  const timeoutMs = options.timeoutMs ?? 75;
  const minBytes = options.minBytes ?? 1024;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  for (const value of [maxConcurrent, timeoutMs, minBytes, maxBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Screenshot encoding bounds must be positive integers");
  }
  const compress = options.compress ?? ((input: Buffer) => new Promise<Buffer>((resolve, reject) => {
    gzip(input, { level: 1 }, (error, result) => error ? reject(error) : resolve(result));
  }));
  let active = 0;
  return {
    async prepare(req: Request, res: Response, body: ScreenshotBody): Promise<Prepared | undefined> {
      if (req.acceptsEncodings("gzip", "identity") !== "gzip" || active >= maxConcurrent
        || req.aborted || res.destroyed || res.headersSent
        || res.get("Content-Encoding") || res.get("Content-Type")) return undefined;
      // Match Express res.json settings. This route's DTO is already public;
      // no token, authentication response or unrelated endpoint uses this encoder.
      let json = JSON.stringify(body, res.app.get("json replacer"), res.app.get("json spaces"));
      if (typeof json !== "string") return undefined;
      if (res.app.get("json escape")) json = json.replace(/[<>&]/g, character => (
        character === "<" ? "\\u003c" : character === ">" ? "\\u003e" : "\\u0026"
      ));
      const prepared: Prepared = { body, json };
      const bytes = Buffer.byteLength(json);
      if (bytes < minBytes || bytes > maxBytes) return prepared;
      active++;
      // A deadline bounds response delay, not physical zlib concurrency. Keep
      // the permit until the real work settles, even when identity has won.
      const work = Promise.resolve().then(() => compress(Buffer.from(json))).finally(() => { active--; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const compressed = await Promise.race([
          work,
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
        ]);
        if (compressed && compressed.length < bytes && !req.aborted && !res.destroyed) prepared.compressed = compressed;
      } catch { /* Compression is optional; the original representation remains valid. */ }
      finally { if (timer !== undefined) clearTimeout(timer); }
      return prepared;
    },
    send(res: Response, body: ScreenshotBody, prepared?: Prepared) {
      res.vary("Accept-Encoding");
      if (!prepared || prepared.body !== body || res.get("Content-Encoding") || res.get("Content-Type")) return res.json(body);
      res.set("Content-Type", "application/json; charset=utf-8");
      if (prepared.compressed) {
        res.set("Content-Encoding", "gzip");
        return res.send(prepared.compressed);
      }
      return res.send(prepared.json);
    },
  };
}
export const screenshotResponseEncoder = createScreenshotResponseEncoder();
