import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { z } from "zod";
import { normalizeMyDeskFile, validateMyDeskFileMetadata, MYDESK_MAX_FILE_BYTES } from "../services/mydeskFiles.js";
import { prepareImportSource, renderImportSource, cropImportRegion, buildImportAttachment,
  type ImportRegionImage } from "../services/mydeskImportProcessing.js";

const configuration = z.object({
  role: z.enum(["api", "worker", "combined"]).default("combined"),
  scenario: z.enum(["smoke", "max"]).default("smoke"),
  deadlineSeconds: z.number().int().min(1).max(600),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().default(null),
}).strict();
export type MeasurementOptions = z.infer<typeof configuration>;
const countsSchema = z.object({
  packets: z.number().int().nonnegative(), sources: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(), sourcePages: z.number().int().nonnegative(), maxSourcePages: z.number().int().nonnegative(),
  renderedPages: z.number().int().nonnegative(), forms: z.number().int().nonnegative(),
  continuationRegions: z.number().int().nonnegative(), attachmentBytes: z.number().int().nonnegative(),
  ordinaryUploads: z.number().int().nonnegative(), ordinaryPdfBytesPreserved: z.boolean(),
  upperBoundMetadataChecks: z.number().int().nonnegative(), oversizeMetadataRejected: z.boolean(),
}).strict();
const timingSchema = z.object({ ordinaryNormalization: z.number().nonnegative(), sourcePreparation: z.number().nonnegative(),
  rendering: z.number().nonnegative(), extractionCropPreparation: z.number().nonnegative(), attachmentPreparation: z.number().nonnegative() }).strict();
const failedOperationSchema = z.enum(["ordinaryNormalization", "sourcePreparation", "rendering", "extractionCropPreparation", "attachmentPreparation"]).nullable();
const childMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory"), rss: z.number().int().nonnegative(), heapUsed: z.number().int().nonnegative(),
    external: z.number().int().nonnegative(), arrayBuffers: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("result"), status: z.enum(["completed", "cancelled", "failed"]),
    counts: countsSchema, fixtureMs: z.number().nonnegative(), processingMs: z.number().nonnegative(),
    operationElapsedMs: timingSchema, failedOperation: failedOperationSchema }).strict(),
]);
type ChildResult = Extract<z.infer<typeof childMessage>, { kind: "result" }>;

export function parseMyDeskMeasurementArgs(args: string[]): MeasurementOptions {
  const input: Record<string, unknown> = {};
  const fields: Record<string, string> = { "--role": "role", "--scenario": "scenario", "--deadline-seconds": "deadlineSeconds", "--image-digest": "imageDigest" };
  for (let i = 0; i < args.length; i += 2) {
    const field = fields[args[i]!], value = args[i + 1];
    if (!field || value === undefined || field in input) throw new Error("MYDESK_MEASUREMENT_CONFIGURATION");
    input[field] = field === "deadlineSeconds" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  }
  input.deadlineSeconds ??= input.scenario === "max" ? 600 : 90;
  const parsed = configuration.safeParse(input);
  if (!parsed.success) throw new Error("MYDESK_MEASUREMENT_CONFIGURATION");
  return parsed.data;
}

function emptyCounts(): z.infer<typeof countsSchema> {
  return { packets: 0, sources: 0, inputBytes: 0, sourcePages: 0, maxSourcePages: 0, renderedPages: 0, forms: 0,
    continuationRegions: 0, attachmentBytes: 0, ordinaryUploads: 0, ordinaryPdfBytesPreserved: true,
    upperBoundMetadataChecks: 0, oversizeMetadataRejected: false };
}
function checkpoint(signal: AbortSignal) { if (signal.aborted) throw new Error("MYDESK_MEASUREMENT_CANCELLED"); }

async function syntheticPdf(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setCreationDate(new Date(0)); pdf.setModificationDate(new Date(0));
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([612, 792]);
    for (let form = 0; form < 3; form++) {
      const y = 760 - form * 245;
      page.drawRectangle({ x: 20, y: y - 225, width: 570, height: 220, borderColor: rgb(0, 0, 0), borderWidth: 1 });
      page.drawText("SYNTHETIC CAPACITY FORM", { x: 35, y: y - 20, size: 13, font });
      for (let line = 0; line < 8; line++) page.drawText("Synthetic processing fixture. No student information or provider request.",
        { x: 35, y: y - 45 - line * 19, size: 10, font });
    }
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** Increase byte pressure without changing page complexity or document labels. */
export function padSyntheticPdf(bytes: Buffer, targetBytes: number): Buffer {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < bytes.length || targetBytes > MYDESK_MAX_FILE_BYTES) throw new Error("MYDESK_MEASUREMENT_FIXTURE");
  if (targetBytes === bytes.length) return bytes;
  const input = bytes.toString("latin1"), marker = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(input);
  if (!marker) throw new Error("MYDESK_MEASUREMENT_FIXTURE");
  const xref = Number(marker[1]);
  if (input.slice(xref, xref + 4) !== "xref") throw new Error("MYDESK_MEASUREMENT_FIXTURE");
  // Insert legal whitespace before xref and update its byte offset. Object offsets stay fixed.
  let padding = targetBytes - bytes.length;
  for (let attempt = 0; attempt < 4; attempt++) {
    const newXref = xref + padding;
    const extraDigits = String(newXref).length - marker[1]!.length;
    const next = targetBytes - bytes.length - extraDigits;
    if (next === padding) break;
    padding = next;
  }
  if (padding < 1) throw new Error("MYDESK_MEASUREMENT_FIXTURE");
  const tail = input.slice(xref).replace(/(startxref\s+)\d+(\s+%%EOF\s*)$/, (_match, prefix: string, suffix: string) => `${prefix}${xref + padding}${suffix}`);
  const result = Buffer.concat([bytes.subarray(0, xref), Buffer.alloc(padding, 32), Buffer.from(tail, "latin1")]);
  if (result.length !== targetBytes) throw new Error("MYDESK_MEASUREMENT_FIXTURE");
  return result;
}

async function executeScenario(options: MeasurementOptions, directory: string, signal: AbortSignal): Promise<ChildResult> {
  const counts = emptyCounts(), started = performance.now();
  const operationElapsedMs = { ordinaryNormalization: 0, sourcePreparation: 0, rendering: 0, extractionCropPreparation: 0, attachmentPreparation: 0 };
  let failedOperation: z.infer<typeof failedOperationSchema> = null;
  const failureController = new AbortController(), cancelled = AbortSignal.any([signal, failureController.signal]);
  const externalSignal = signal; signal = cancelled;
  async function timed<T>(name: keyof typeof operationElapsedMs, operation: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await operation(); }
    catch (error) { failedOperation ??= name; throw error; }
    finally { operationElapsedMs[name] += performance.now() - start; }
  }
  let fixtureMs = 0, processingStarted = started;
  try {
    const isMax = options.scenario === "max";
    const templates = await Promise.all([syntheticPdf(1), syntheticPdf(isMax ? 16 : 1)]);
    checkpoint(signal);
    const photo = await sharp({ create: { width: isMax ? 6000 : 640, height: isMax ? 4000 : 480, channels: 3, background: "#eeeeee" } })
      .jpeg({ quality: 94 }).timeout({ seconds: 15 }).toBuffer();
    checkpoint(signal);
    fixtureMs = performance.now() - started; processingStarted = performance.now();
    for (let i = 0; i < 5; i++) { validateMyDeskFileMetadata("application/pdf", MYDESK_MAX_FILE_BYTES); counts.upperBoundMetadataChecks++; }
    try { validateMyDeskFileMetadata("application/pdf", MYDESK_MAX_FILE_BYTES + 1); }
    catch { counts.oversizeMetadataRejected = true; }
    if (!counts.oversizeMetadataRejected) throw new Error("MYDESK_MEASUREMENT_BOUNDARY");

    async function ordinaryUpload() {
      checkpoint(signal);
      const input = isMax ? padSyntheticPdf(templates[0]!, MYDESK_MAX_FILE_BYTES) : templates[0]!;
      const result = await timed("ordinaryNormalization", () => normalizeMyDeskFile(input, "application/pdf", { signal }));
      counts.ordinaryPdfBytesPreserved &&= result.bytes.equals(input);
      counts.ordinaryUploads++;
      checkpoint(signal);
      await timed("ordinaryNormalization", () => normalizeMyDeskFile(photo, "image/jpeg", { signal }));
      counts.ordinaryUploads++;
    }
    async function packet(index: number) {
      const path = join(directory, `packet-${index}`); await mkdir(path);
      // Concentrate pages in one source to exercise retained render output, while
      // also reaching the five-file, 20-page and 50 MiB packet limits together.
      const sourceCounts = isMax ? [16, 1, 1, 1, 1] : [1, 1];
      let pageIndex = 0;
      for (let sourceIndex = 0; sourceIndex < sourceCounts.length; sourceIndex++) {
        checkpoint(signal);
        const isPhoto = sourceIndex === sourceCounts.length - 1;
        let bytes = isPhoto ? photo : templates[sourceCounts[sourceIndex] === 16 ? 1 : 0]!;
        if (isMax) bytes = isPhoto ? Buffer.concat([photo, Buffer.alloc(MYDESK_MAX_FILE_BYTES - photo.length)]) : padSyntheticPdf(bytes, MYDESK_MAX_FILE_BYTES);
        counts.sources++; counts.inputBytes += bytes.length;
        const prepared = await timed("sourcePreparation", () => prepareImportSource(bytes, isPhoto ? "image/jpeg" : "application/pdf", { signal }));
        counts.sourcePages += prepared.pageCount;
        counts.maxSourcePages = Math.max(counts.maxSourcePages, prepared.pageCount);
        checkpoint(signal);
        if (options.role === "api") continue;
        const pages = await timed("rendering", () => renderImportSource(prepared.bytes, prepared.contentType, { signal }));
        for (const page of pages) {
          checkpoint(signal);
          await writeFile(join(path, `${pageIndex++}.jpg`), page.bytes, { mode: 0o600 });
          counts.renderedPages++;
        }
      }
      if (options.role !== "api") {
        const forms = isMax ? 50 : 3;
        for (let form = 0; form < forms; form++) {
          checkpoint(signal);
          const continuation = form === forms - 1;
          const regions: ImportRegionImage[] = [];
          const regionCount = continuation ? pageIndex : 1;
          for (let region = 0; region < regionCount; region++) {
            checkpoint(signal);
            const source = await readFile(join(path, `${continuation ? region : form % pageIndex}.jpg`));
            const input: ImportRegionImage = { bytes: source, rotation: 0,
              region: continuation ? { x: 0.05, y: 0.05, width: 0.9, height: 0.2 } : { x: 0, y: (form % 3) / 3, width: 1, height: 1 / 3 } };
            // Extraction-input preparation and final attachment preparation both crop in the real worker.
            await timed("extractionCropPreparation", () => cropImportRegion(input)); checkpoint(signal); regions.push(input);
          }
          const attachment = await timed("attachmentPreparation", () => buildImportAttachment(regions));
          checkpoint(signal);
          if (continuation && attachment.contentType !== "application/pdf") throw new Error("MYDESK_MEASUREMENT_CONTINUATION");
          counts.forms++; counts.attachmentBytes += attachment.bytes.length;
          if (continuation) counts.continuationRegions += regionCount;
        }
      }
      counts.packets++;
    }
    const jobs = [packet(0), packet(1)];
    if (options.role !== "worker") jobs.push(ordinaryUpload(), ordinaryUpload());
    // Draining all started branches avoids background processing after failure/cancellation.
    const settled = await Promise.allSettled(jobs.map(job => job.catch(() => { failureController.abort(); throw new Error("MYDESK_MEASUREMENT_PROCESSING"); })));
    if (settled.some(result => result.status === "rejected")) throw new Error("MYDESK_MEASUREMENT_PROCESSING");
    return { kind: "result", status: "completed", counts, fixtureMs, processingMs: performance.now() - processingStarted, operationElapsedMs, failedOperation };
  } catch {
    return { kind: "result", status: externalSignal.aborted ? "cancelled" : "failed", counts, fixtureMs, processingMs: performance.now() - processingStarted, operationElapsedMs, failedOperation };
  }
}

type Memory = { current: number | null; peak: number | null; limit: number | null; version: "v2" | "v1" | "unavailable" };
const numericMemory = (raw: string | undefined): number | null => {
  if (!raw || !/^[0-9]+$/.test(raw.trim())) return null;
  const value = Number(raw.trim()); return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
export async function readMeasurementCgroup(): Promise<Memory> {
  for (const [version, paths] of [
    ["v2", ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory.max"]],
    ["v1", ["/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]],
  ] as const) {
    const values = await Promise.all(paths.map(path => readFile(path, "utf8").catch(() => undefined)));
    if (values[0] !== undefined) return { version, current: numericMemory(values[0]), peak: numericMemory(values[1]), limit: numericMemory(values[2]) };
  }
  return { version: "unavailable", current: null, peak: null, limit: null };
}

/** Run only in an isolated task/container. No database, object store or provider transport is used. */
export async function measureMyDeskProcessing(options: MeasurementOptions) {
  options = configuration.parse(options);
  const started = performance.now(), directory = await mkdtemp(join(tmpdir(), "mydesk-measure-"));
  let child: ChildProcess | undefined, childResult: ChildResult | null = null, outputBytes = 0;
  let failure: "MEMORY_STOP" | "DEADLINE" | "INTERRUPTED" | "PROCESSING_FAILED" | "INVALID_CHILD_OUTPUT" | null = null;
  let hardKilled = false, memorySamples = 0, sampledPeak = 0, childClosed = false;
  let childFinished: Promise<void> | undefined, treeKill: Promise<void> | undefined;
  const processPeaks = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  const before = await readMeasurementCgroup();
  let lastMemory = before, sample: Promise<void> | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  const terminateGroup = () => {
    if (childClosed || hardKilled) return;
    hardKilled = true;
    if (child?.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    else if (child?.pid && process.platform === "win32") {
      const pid = child.pid;
      treeKill = new Promise<void>(resolveKill => {
        const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", shell: false, timeout: 5000 });
        killer.once("error", () => { child?.kill("SIGKILL"); });
        killer.once("close", () => { if (!childClosed) child?.kill("SIGKILL"); resolveKill(); });
      });
    } else child?.kill("SIGKILL");
  };
  const stop = (code: NonNullable<typeof failure>) => {
    failure ??= code;
    try { if (child?.connected) child.send({ cancel: true }, () => {}); } catch { /* Hard deadline still owns the process group. */ }
    if (!childClosed) hardTimer ??= setTimeout(terminateGroup, 20_000);
  };
  const takeSample = async () => {
    lastMemory = await readMeasurementCgroup(); memorySamples++;
    sampledPeak = Math.max(sampledPeak, lastMemory.current ?? 0);
    if (lastMemory.limit && lastMemory.current !== null && lastMemory.current / lastMemory.limit >= 0.85) stop("MEMORY_STOP");
  };
  const timer = setInterval(() => { if (!sample) sample = takeSample().finally(() => { sample = undefined; }); }, 100);
  const deadline = setTimeout(() => stop("DEADLINE"), options.deadlineSeconds * 1000);
  const interrupt = () => stop("INTERRUPTED");
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    const entry = fileURLToPath(import.meta.url);
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, LANG: "C", LC_ALL: "C",
      TMPDIR: directory, TEMP: directory, TMP: directory, MYDESK_MEASUREMENT_CHILD: "1" };
    if (process.platform === "win32") { env.SystemRoot = process.env.SystemRoot; env.WINDIR = process.env.WINDIR; }
    child = spawn(process.execPath, [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry, "--internal-worker", JSON.stringify(options)], {
      env, cwd: resolve(dirname(entry), "../.."), detached: process.platform !== "win32", windowsHide: true,
      shell: false, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    childFinished = new Promise<void>(resolveChild => {
      child!.once("error", () => { failure ??= "PROCESSING_FAILED"; });
      child!.once("close", code => {
        childClosed = true; clearTimeout(hardTimer);
        // A native child can outlive a crashed/OOM-killed Node leader. Its owned
        // process group is still identifiable immediately at the leader's close.
        if (child?.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group already drained. */ } }
        if (code !== 0) failure ??= "PROCESSING_FAILED"; resolveChild();
      });
    });
    child.on("message", value => {
      const message = childMessage.safeParse(value);
      if (!message.success) { stop("INVALID_CHILD_OUTPUT"); return; }
      if (message.data.kind === "result") childResult = message.data;
      else for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const) processPeaks[key] = Math.max(processPeaks[key], message.data[key]);
    });
    const discard = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 8192) stop("INVALID_CHILD_OUTPUT"); };
    child.stdout?.on("data", discard); child.stderr?.on("data", discard);
    await takeSample();
    await childFinished;
  } catch { failure ??= "PROCESSING_FAILED"; terminateGroup(); }
  finally {
    await childFinished; await treeKill;
    clearInterval(timer); clearTimeout(deadline); clearTimeout(hardTimer); await sample;
    await takeSample(); clearTimeout(hardTimer);
    await rm(directory, { recursive: true, force: true }).catch(() => { failure ??= "PROCESSING_FAILED"; });
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
  // Copy the IPC result through its whitelist; never include subprocess output/errors, paths or environment.
  const result = childMessage.safeParse(childResult);
  const completed = result.success && result.data.kind === "result" ? result.data : null;
  const peakFraction = lastMemory.limit ? sampledPeak / lastMemory.limit : null;
  // The kernel's lifetime peak catches brief spikes between samples. It can be
  // conservative in a reused cgroup, which is why this command belongs in a
  // fresh isolated task and also reports the starting lifetime peak.
  const observedPeak = Math.max(sampledPeak, lastMemory.peak ?? 0);
  const observedPeakFraction = lastMemory.limit ? observedPeak / lastMemory.limit : null;
  return {
    schemaVersion: 1, measurement: "synthetic_processing_only", role: options.role, scenario: options.scenario,
    imageDigest: options.imageDigest, imageDigestVerified: false, platform: process.platform,
    status: failure || completed?.status !== "completed" ? "failed" : "completed",
    failureCode: failure ?? (completed?.status === "completed" ? null : "PROCESSING_FAILED"),
    durationMs: Math.round(performance.now() - started), deadlineSeconds: options.deadlineSeconds, hardKilled,
    fixtureMs: completed?.fixtureMs ?? null, processingMs: completed?.processingMs ?? null, counts: completed?.counts ?? emptyCounts(),
    operationElapsedMs: completed?.operationElapsedMs ?? null,
    failedOperation: completed?.failedOperation ?? null,
    memory: { cgroupVersion: lastMemory.version, cgroupLimitBytes: lastMemory.limit, cgroupBeforeBytes: before.current,
      cgroupLifetimePeakBeforeBytes: before.peak, cgroupLifetimePeakAfterBytes: lastMemory.peak,
      sampledCgroupPeakBytes: sampledPeak || null, sampledCgroupPeakFraction: peakFraction,
      observedCgroupPeakBytes: observedPeak || null, observedCgroupPeakFraction: observedPeakFraction,
      samples: memorySamples, sampleIntervalMs: 100, childProcessPeaks: processPeaks },
    processingHeadroomBelow70Percent: failure || completed?.status !== "completed" || observedPeakFraction === null ? null : observedPeakFraction < 0.70,
    productionReadinessEstablished: false,
    limitations: ["synthetic_pages_and_padding_are_not_worst_case_documents", "fixture_generation_and_supervisor_memory_are_included",
      "cgroup_peak_includes_other_processes_and_earlier_activity", "image_digest_is_operator_supplied_not_verified",
      "no_provider_database_storage_network_or_scheduler_load", "no_api_latency_or_extraction_quality_measurement",
      "combined_role_is_colocated_not_serving_topology", "sampled_memory_can_miss_short_peaks", "operation_elapsed_times_include_queue_wait_and_overlap"],
  };
}

async function workerMain(raw: string) {
  const options = configuration.parse(JSON.parse(raw)), controller = new AbortController();
  let disconnected = false, hardStop: NodeJS.Timeout | undefined;
  const cancel = () => {
    controller.abort();
    hardStop ??= setTimeout(() => {
      // The supervisor normally owns this stop; retain a deadline if it crashes.
      if (process.platform !== "win32") { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } }
      else process.exit(1);
    }, 20_000);
  };
  process.on("message", message => { if (message && typeof message === "object" && "cancel" in message && message.cancel === true) cancel(); });
  const disconnect = () => { disconnected = true; cancel(); };
  process.on("disconnect", disconnect);
  const deadline = setTimeout(cancel, options.deadlineSeconds * 1000);
  const sendMemory = () => { const m = process.memoryUsage(); if (process.connected) process.send?.({ kind: "memory", rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers }, () => {}); };
  const sampler = setInterval(sendMemory, 100); sendMemory();
  try {
    const result = await executeScenario(options, process.env.TMPDIR!, controller.signal);
    sendMemory(); if (process.connected) process.send?.(result, () => {});
  } finally {
    clearInterval(sampler); clearTimeout(deadline); clearTimeout(hardStop);
    process.off("disconnect", disconnect);
    if (disconnected) await rm(process.env.TMPDIR!, { recursive: true, force: true });
    if (process.connected) process.disconnect?.();
  }
}

export async function runMyDeskProcessingCli(args: string[]): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write("Usage: node dist/cli/measureMyDeskProcessing.js [--role api|worker|combined] [--scenario smoke|max] [--deadline-seconds 1..600] [--image-digest sha256:<digest>]\nDefault: small smoke, combined role, 90 seconds. Max: two 20-page/50-form packets, five 10 MiB sources each, 600 seconds. Run only in an isolated task/container. Output is processing evidence, never AI or production-readiness approval.\n"); return 0;
  }
  let options: MeasurementOptions;
  try { options = parseMyDeskMeasurementArgs(args); }
  catch { process.stderr.write('{"status":"failed","failureCode":"MYDESK_MEASUREMENT_CONFIGURATION"}\n'); return 2; }
  try {
    const report = await measureMyDeskProcessing(options);
    process.stdout.write(`${JSON.stringify(report)}\n`); return report.status === "completed" ? 0 : 1;
  } catch { process.stderr.write('{"status":"failed","failureCode":"MYDESK_MEASUREMENT_FAILED"}\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--internal-worker" && process.env.MYDESK_MEASUREMENT_CHILD === "1" && process.send) {
    try { await workerMain(process.argv[3]!); } catch { process.exitCode = 1; process.disconnect?.(); }
  } else process.exitCode = await runMyDeskProcessingCli(process.argv.slice(2));
}
