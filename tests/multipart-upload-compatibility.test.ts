import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import test from "node:test";
import express from "express";
import multer from "multer";

const boundary = "schoolpilot-upload-compatibility";
const fileLimit = 32;

function filePart(field: string, filename: string, mimeType: string, contents: Buffer, complete = true): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    contents,
    ...(complete ? [Buffer.from(`\r\n--${boundary}--\r\n`)] : []),
  ]);
}

async function withUploads(run: (send: (path: string, body: Buffer) => Promise<{ status: number; body: unknown }>, accepted: () => number) => Promise<void>): Promise<void> {
  const app = express();
  let accepted = 0;
  const receive: express.RequestHandler = (req, res) => {
    accepted += 1;
    assert.ok(req.file);
    res.json({ name: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, bytes: req.file.buffer.toString("base64") });
  };
  // The same memory-storage/single-file contracts used by CSV imports,
  // certificates, and OneRoster uploads, with tiny limits for local fixtures.
  app.post("/csv", multer({
    storage: multer.memoryStorage(), limits: { fileSize: fileLimit, files: 1 },
    fileFilter: (_req, file, callback) => callback(null, file.mimetype === "text/csv" || /\.csv$/i.test(file.originalname)),
  }).single("file"), receive);
  app.post("/certificate", multer({ storage: multer.memoryStorage(), limits: { fileSize: fileLimit } }).single("certificate"), receive);
  app.post("/zip", multer({ storage: multer.memoryStorage(), limits: { fileSize: fileLimit, files: 1, fields: 0, parts: 2 } }).single("file"), receive);
  app.use(((error, _req, res, _next) => {
    res.status(400).json({ code: error instanceof multer.MulterError ? error.code : "INVALID_MULTIPART" });
  }) satisfies express.ErrorRequestHandler);
  const server = createServer(app);
  const send = (path: string, body: Buffer) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const outgoing = request({
      host: "127.0.0.1", port: address.port, path, method: "POST", agent: false,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length, connection: "close" },
    }, (incoming) => {
      let responseBody = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => { responseBody += chunk; });
      incoming.on("error", reject);
      incoming.on("end", () => {
        try { resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(responseBody) }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    const deadline = setTimeout(() => outgoing.destroy(new Error("Multipart request did not finish within five seconds")), 5_000);
    outgoing.on("close", () => clearTimeout(deadline));
    outgoing.end(body);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    await run(send, () => accepted);
  } finally {
    // Explicitly destroy sockets even when a malformed request times out.
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("memory uploads retain exact CSV, certificate, and ZIP bytes", { timeout: 20_000 }, async () => {
  // Keep the scaled fixture aligned with the actual OneRoster middleware.
  const rosterRoute = readFileSync(new URL("../src/routes/classpilot/rosterIntegrations.ts", import.meta.url), "utf8");
  assert.match(rosterRoute, /limits:\s*\{\s*fileSize:\s*ROSTER_LIMITS\.compressedBytes,\s*files:\s*1,\s*fields:\s*0,\s*parts:\s*2\s*\}/);
  await withUploads(async (send, accepted) => {
    const fixtures = [
      { path: "/csv", field: "file", name: "roster.csv", mimeType: "text/csv", bytes: Buffer.from("name\nTest\n") },
      { path: "/certificate", field: "certificate", name: "certificate.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.0\n") },
      { path: "/zip", field: "file", name: "roster.zip", mimeType: "application/zip", bytes: Buffer.from("504b0506000000000000000000000000000000000000", "hex") },
    ];
    for (const fixture of fixtures) {
      assert.deepEqual(await send(fixture.path, filePart(fixture.field, fixture.name, fixture.mimeType, fixture.bytes)), {
        status: 200,
        body: { name: fixture.name, mimeType: fixture.mimeType, size: fixture.bytes.length, bytes: fixture.bytes.toString("base64") },
      });
    }
    assert.equal(accepted(), fixtures.length);
  });
});

test("file-size, extra-file, and disallowed-field limits stop uploads before the handler", { timeout: 20_000 }, async () => {
  await withUploads(async (send, accepted) => {
    assert.deepEqual(await send("/zip", filePart("file", "roster.zip", "application/zip", Buffer.alloc(fileLimit + 1))), {
      status: 400, body: { code: "LIMIT_FILE_SIZE" },
    });
    const field = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="unwanted"\r\n\r\nvalue\r\n--${boundary}--\r\n`);
    assert.deepEqual(await send("/zip", field), { status: 400, body: { code: "LIMIT_FIELD_COUNT" } });
    const firstFile = filePart("file", "roster.zip", "application/zip", Buffer.from("PK"), false);
    const secondFile = filePart("file", "second.zip", "application/zip", Buffer.from("PK"));
    assert.deepEqual(await send("/zip", Buffer.concat([firstFile, Buffer.from("\r\n"), secondFile])), {
      status: 400, body: { code: "LIMIT_FILE_COUNT" },
    });
    assert.deepEqual(await send("/zip", Buffer.concat([firstFile, Buffer.from("\r\n"), field])), {
      status: 400, body: { code: "LIMIT_FIELD_COUNT" },
    });
    assert.equal(accepted(), 0);
  });
});

test("a truncated multipart file returns an error and the server accepts the next upload", { timeout: 15_000 }, async () => {
  await withUploads(async (send, accepted) => {
    const bytes = Buffer.from("name\nTest\n");
    assert.deepEqual(await send("/csv", filePart("file", "roster.csv", "text/csv", bytes, false)), {
      status: 400, body: { code: "INVALID_MULTIPART" },
    });
    assert.equal(accepted(), 0);
    assert.equal((await send("/csv", filePart("file", "roster.csv", "text/csv", bytes))).status, 200);
    assert.equal(accepted(), 1);
  });
});
