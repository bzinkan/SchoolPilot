import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPrivateNativeProcessing, privateNativeProcessing, PrivateNativeProcessingError,
  type PrivateNativeProcessing } from "./privateNativeProcessing.js";

type PdfErrorCode = "invalid_pdf" | "pdf_page_limit" | "pdf_busy" | "pdf_aborted" | "pdf_timeout" | "pdf_unavailable" | "pdf_failed";
export class PrivatePdfError extends Error {
  constructor(public readonly code: PdfErrorCode) { super(code); this.name = "PrivatePdfError"; }
  get retryable() { return !["invalid_pdf", "pdf_page_limit"].includes(this.code); }
}

type SpawnPdfChild = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type PdfOptions = { signal?: AbortSignal };
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8192;
const INSPECTION_TIMEOUT_MS = 15_000;

/** Constructor injection exercises process failures without invoking an AI provider or weakening runtime limits. */
export function createPrivatePdfProcessor(options: {
  spawnChild?: SpawnPdfChild; platform?: NodeJS.Platform; maxQueued?: number; waitMs?: number;
  nativeProcessing?: PrivateNativeProcessing;
} = {}) {
  const spawnChild = options.spawnChild ?? ((command, args, childOptions) => spawn(command, args, childOptions));
  const platform = options.platform ?? process.platform;
  const native = options.nativeProcessing ?? createPrivateNativeProcessing(options);
  async function acquire(signal: AbortSignal | undefined, deadline: number) {
    try { return await native.acquire({ signal, deadline }); }
    catch (error) {
      if (error instanceof PrivateNativeProcessingError) throw new PrivatePdfError(`pdf_${error.code}`);
      throw new PrivatePdfError("pdf_failed");
    }
  }

  async function execute(tool: "pdfinfo" | "pdftoppm", args: string[], directory: string,
    deadline: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new PrivatePdfError("pdf_aborted");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PrivatePdfError("pdf_timeout");
    const executable = platform === "win32" ? `${tool}.exe` : `/usr/bin/${tool}`;
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: directory, TEMP: directory, TMP: directory };
    if (platform === "win32") {
      environment.PATH = process.env.PATH;
      environment.SystemRoot = process.env.SystemRoot; environment.WINDIR = process.env.WINDIR;
    }
    // Production Linux has no unbounded fallback if Poppler or prlimit is unavailable.
    const command = platform === "linux" ? "/usr/bin/prlimit" : executable;
    const argumentsList = platform === "linux"
      ? ["--as=536870912", "--cpu=30", "--fsize=16777216", "--nofile=64", "--", executable, ...args]
      : args;
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnChild(command, argumentsList, { cwd: directory, env: environment, windowsHide: true,
          shell: false, stdio: ["ignore", "pipe", "pipe"] });
      } catch { reject(new PrivatePdfError("pdf_unavailable")); return; }
      let failure: PdfErrorCode | undefined;
      let outputBytes = 0;
      let hasDiagnostics = false;
      const output: Buffer[] = [];
      const stop = (code: PdfErrorCode) => { failure ??= code; child.kill("SIGKILL"); };
      const abort = () => stop("pdf_aborted");
      const timer = setTimeout(() => stop("pdf_timeout"), remaining);
      signal?.addEventListener("abort", abort, { once: true });
      const consume = (chunk: Buffer, retain: boolean) => {
        outputBytes += chunk.length;
        if (!retain && chunk.length > 0) hasDiagnostics = true;
        if (outputBytes > MAX_OUTPUT_BYTES) { stop("invalid_pdf"); return; }
        if (retain && !failure) output.push(chunk);
      };
      child.stdout?.on("data", (chunk: Buffer) => consume(chunk, true));
      child.stderr?.on("data", (chunk: Buffer) => consume(chunk, false));
      child.once("error", () => { failure ??= "pdf_unavailable"; });
      // An abort/error event is insufficient: release the permit and delete temporary files only after close.
      child.once("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        // Poppler can repair damaged cross-references and still exit zero.
        // Inspection diagnostics therefore reject the source; never retain or
        // disclose their text, which can include private document fragments.
        if (failure || code !== 0 || (tool === "pdfinfo" && hasDiagnostics)) reject(new PrivatePdfError(failure ?? (code === 126 || code === 127 ? "pdf_unavailable" : "invalid_pdf")));
        else resolve(Buffer.concat(output).toString("utf8"));
      });
      if (signal?.aborted) abort();
    });
  }

  async function inspect(bytes: Buffer, settings: PdfOptions & { maxPages: number }): Promise<{ pageCount: number }> {
    if (!Number.isSafeInteger(settings.maxPages) || settings.maxPages < 1 || settings.maxPages > 1000 ||
      !bytes.length || bytes.length > MAX_INPUT_BYTES || !/^%PDF-(?:1\.[0-9]|2\.0)/.test(bytes.subarray(0, 8).toString("ascii")) ||
      !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from("%%EOF"))) throw new PrivatePdfError("invalid_pdf");
    const deadline = Date.now() + INSPECTION_TIMEOUT_MS;
    const release = await acquire(settings.signal, deadline);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "mydesk-pdf-"));
      const input = join(directory, "source.pdf");
      await writeFile(input, bytes, { mode: 0o600 });
      const output = await execute("pdfinfo", [input], directory, deadline, settings.signal);
      // Other pdfinfo fields can contain private document metadata. Never return or log them.
      const pages = [...output.matchAll(/^Pages:[ \t]+([0-9]+)[ \t]*\r?$/gm)];
      const encryption = [...output.matchAll(/^Encrypted:[ \t]+(yes|no)(?:[ \t].*)?\r?$/gm)];
      if (pages.length !== 1 || encryption.length !== 1 || encryption[0]![1] !== "no") throw new PrivatePdfError("invalid_pdf");
      const pageCount = Number(pages[0]![1]);
      if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new PrivatePdfError("invalid_pdf");
      if (pageCount > settings.maxPages) throw new PrivatePdfError("pdf_page_limit");
      return { pageCount };
    } catch (error) {
      throw error instanceof PrivatePdfError ? error : new PrivatePdfError("pdf_failed");
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      catch { throw new PrivatePdfError("pdf_failed"); }
      finally { release(); }
    }
  }

  async function renderPage(settings: PdfOptions & { source: string; outputPrefix: string; page: number; maxEdge: number; timeoutMs: number }): Promise<void> {
    if (!Number.isSafeInteger(settings.page) || settings.page < 1 || settings.page > 20 ||
      !Number.isSafeInteger(settings.maxEdge) || settings.maxEdge < 1 || settings.maxEdge > 4096 ||
      !Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0) throw new PrivatePdfError("invalid_pdf");
    const deadline = Date.now() + Math.min(settings.timeoutMs, 45_000);
    const release = await acquire(settings.signal, deadline);
    try {
      await execute("pdftoppm", ["-f", String(settings.page), "-l", String(settings.page), "-singlefile", "-scale-to", String(settings.maxEdge),
        "-jpeg", "-jpegopt", "quality=94", settings.source, settings.outputPrefix], dirname(settings.source), deadline, settings.signal);
    } finally { release(); }
  }
  return { inspect, renderPage };
}

// Ordinary files, AI source inspection/rendering, and every Sharp transform
// share the same process-wide permit. Provider/storage work never holds it.
const privatePdfProcessor = createPrivatePdfProcessor({ nativeProcessing: privateNativeProcessing });
export const inspectPrivatePdf = privatePdfProcessor.inspect;
export const renderPrivatePdfPage = privatePdfProcessor.renderPage;
