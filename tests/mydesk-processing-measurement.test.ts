import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { parseMyDeskMeasurementArgs, padSyntheticPdf, measureMyDeskProcessing, readMeasurementCgroup, readMeasurementTaskMemory,
  type MeasurementMemory } from "../src/cli/measureMyDeskProcessing.js";
import { inspectPrivatePdf } from "../src/services/privatePdfProcessing.js";
import { MYDESK_MAX_FILE_BYTES } from "../src/services/mydeskFiles.js";

test("capacity work defaults to a bounded smoke and accepts only explicit finite workload options", () => {
  assert.deepEqual(parseMyDeskMeasurementArgs([]), { role: "combined", scenario: "smoke", deadlineSeconds: 90, imageDigest: null });
  assert.equal(parseMyDeskMeasurementArgs(["--scenario", "max", "--role", "worker"]).deadlineSeconds, 600);
  assert.equal(parseMyDeskMeasurementArgs(["--role", "api", "--deadline-seconds", "30"]).role, "api");
  for (const args of [["--scenario", "production"], ["--deadline-seconds", "0"], ["--deadline-seconds", "601"],
    ["--deadline-seconds", "Infinity"], ["--deadline-seconds", "1.1"], ["--role", "api", "--role", "worker"],
    ["--role"], ["--image-digest", "PRIVATE-DOCUMENT"], ["--source", "PRIVATE-DOCUMENT"], ["--internal-worker", "{}"]]) {
    assert.throws(() => parseMyDeskMeasurementArgs(args), error => error instanceof Error && error.message === "MYDESK_MEASUREMENT_CONFIGURATION");
  }
});

test("synthetic byte-pressure PDFs meet the real 10 MiB boundary while keeping the same pages", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([612, 792]); pdf.addPage([612, 792]);
  const original = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const padded = padSyntheticPdf(original, MYDESK_MAX_FILE_BYTES);
  assert.equal(padded.length, MYDESK_MAX_FILE_BYTES);
  assert.deepEqual(await inspectPrivatePdf(padded, { maxPages: 20 }), { pageCount: 2 });
  assert.throws(() => padSyntheticPdf(original, MYDESK_MAX_FILE_BYTES + 1));
  assert.throws(() => padSyntheticPdf(Buffer.from("PRIVATE-DOCUMENT"), MYDESK_MAX_FILE_BYTES), /MYDESK_MEASUREMENT_FIXTURE/);
});

const scratchDirectories = async () => new Set((await readdir(tmpdir())).filter(name => name.startsWith("mydesk-measure-")));
const MiB = 1024 * 1024;
// Portable behavioral fixtures, not a claim about the test runner's real capacity.
const fixtureMemory: MeasurementMemory = { current: 100 * MiB, peak: 120 * MiB, limit: 512 * MiB, version: "v2" };
const portableReaders = { cgroup: async () => fixtureMemory, taskMemory: async () => null };

test("cgroup readers distinguish finite v2/v1 limits from unlimited sentinels", async () => {
  const v2: Record<string, string> = { "/sys/fs/cgroup/memory.current": "100", "/sys/fs/cgroup/memory.peak": "120", "/sys/fs/cgroup/memory.max": "536870912" };
  assert.deepEqual(await readMeasurementCgroup(async path => v2[path]), { current: 100, peak: 120, limit: 512 * MiB, version: "v2" });
  v2["/sys/fs/cgroup/memory.max"] = "max";
  assert.equal((await readMeasurementCgroup(async path => v2[path])).limit, null);
  const v1: Record<string, string> = { "/sys/fs/cgroup/memory/memory.usage_in_bytes": "100", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes": "120",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" };
  assert.deepEqual(await readMeasurementCgroup(async path => v1[path]), { current: 100, peak: 120, limit: null, version: "v1" });
  v1["/sys/fs/cgroup/memory/memory.limit_in_bytes"] = "268435456";
  assert.equal((await readMeasurementCgroup(async path => v1[path])).limit, 256 * MiB);
  assert.deepEqual(await readMeasurementCgroup(async () => undefined), { current: null, peak: null, limit: null, version: "unavailable" });
});

const metadataUri = "http://169.254.170.2/v4/synthetic-container";
const metadataBody = { LaunchType: "FARGATE", Limits: { CPU: 0.25, Memory: 512 }, Containers: [{ Type: "NORMAL" }] };
test("Fargate task memory uses only bounded link-local v4 metadata without redirects or credentials", async () => {
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, `${metadataUri}/task`);
    assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "omit");
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json({ ...metadataBody, ArbitraryPrivateField: "never returned" });
  };
  assert.equal(await readMeasurementTaskMemory(metadataUri, request), 512 * MiB);
  for (const uri of ["https://example.com/v4/id", "http://169.254.170.2:8000/v4/id", "http://user:secret@169.254.170.2/v4/id",
    "http://169.254.170.2/v4/id?secret=value", "http://169.254.170.2/v4/id#fragment", "http://169.254.170.2/v2/credentials/id"]) {
    assert.equal(await readMeasurementTaskMemory(uri, request), null);
  }
  assert.equal(calls, 1);
  for (const body of [{}, { ...metadataBody, Limits: { Memory: "512" } }, { ...metadataBody, Limits: { Memory: 0 } },
    { ...metadataBody, Limits: { Memory: 131073 } }, { ...metadataBody, Containers: [{ Type: "NORMAL" }, { Type: "NORMAL" }] }]) {
    assert.equal(await readMeasurementTaskMemory(metadataUri, async () => Response.json(body)), null);
  }
  assert.equal(await readMeasurementTaskMemory(metadataUri, async () => new Response("x".repeat(128 * 1024 + 1))), null);
  assert.equal(await readMeasurementTaskMemory(metadataUri, async () => { throw new Error("PRIVATE-METADATA"); }), null);
});

test("unknown limits or usage fail before generating fixtures or spawning a child", async () => {
  const before = await scratchDirectories();
  for (const [memory, taskLimit] of [[{ ...fixtureMemory, limit: null, version: "v1" }, null],
    [{ ...fixtureMemory, current: null }, 512 * MiB]] satisfies [MeasurementMemory, number | null][]) {
    const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs([]), { cgroup: async () => memory, taskMemory: async () => taskLimit });
    assert.equal(report.failureCode, "MEMORY_UNAVAILABLE"); assert.equal(report.status, "failed");
    assert.equal(report.fixtureMs, null); assert.equal(report.counts.sources, 0); assert.equal(report.memory.childProcessPeaks.rss, 0);
    assert.equal(report.hardKilled, false);
    assert.equal(report.processingHeadroomBelow70Percent, null);
  }
  assert.deepEqual(await scratchDirectories(), before);
});

test("unlimited v1 uses the verified task limit and a smaller finite cgroup always caps it", async () => {
  for (const [cgroupLimit, taskLimit, expectedLimit, source] of [[null, 512 * MiB, 512 * MiB, "ecs_task_metadata"],
    [256 * MiB, 512 * MiB, 256 * MiB, "cgroup"], [512 * MiB, 256 * MiB, 256 * MiB, "ecs_task_metadata"]] satisfies [number | null, number, number, string][]) {
    const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs([]), {
      cgroup: async () => ({ current: expectedLimit * 0.9, peak: expectedLimit * 0.9, limit: cgroupLimit, version: "v1" }), taskMemory: async () => taskLimit,
    });
    assert.equal(report.failureCode, "MEMORY_STOP"); assert.equal(report.memory.effectiveLimitBytes, expectedLimit);
    assert.equal(report.memory.effectiveLimitSource, source); assert.equal(report.memory.observedCgroupPeakFraction, 0.9);
    assert.equal(report.fixtureMs, null); assert.equal(report.counts.sources, 0);
  }
});

test("isolated smoke exercises both jobs, ordinary uploads and continuation PDFs without exposing content or claiming readiness", { timeout: 100_000 }, async () => {
  const before = await scratchDirectories();
  const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs(["--image-digest", `sha256:${"a".repeat(64)}`]), portableReaders);
  assert.equal(report.status, "completed", JSON.stringify(report));
  assert.equal(report.failureCode, null);
  assert.equal(report.failedOperation, null);
  assert.deepEqual(report.counts, { packets: 2, sources: 4, inputBytes: report.counts.inputBytes, sourcePages: 4, maxSourcePages: 1,
    renderedPages: 4, forms: 6, continuationRegions: 4, attachmentBytes: report.counts.attachmentBytes,
    ordinaryUploads: 4, ordinaryPdfBytesPreserved: true, upperBoundMetadataChecks: 5, oversizeMetadataRejected: true });
  assert.ok(report.counts.inputBytes > 0 && report.counts.attachmentBytes > 0);
  assert.equal(report.productionReadinessEstablished, false);
  assert.equal(report.imageDigestVerified, false);
  assert.ok(report.memory.childProcessPeaks.rss > 0);
  assert.ok(report.memory.samples > 0);
  assert.ok((report.memory.observedCgroupPeakBytes ?? 0) >= (report.memory.sampledCgroupPeakBytes ?? 0));
  assert.ok((report.memory.observedCgroupPeakBytes ?? 0) >= (report.memory.cgroupLifetimePeakAfterBytes ?? 0));
  assert.equal(report.processingHeadroomBelow70Percent,
    report.memory.observedCgroupPeakFraction === null ? null : report.memory.observedCgroupPeakFraction < 0.70);
  assert.ok(report.limitations.includes("no_provider_database_storage_network_or_scheduler_load"));
  assert.ok(report.limitations.includes("provider_image_downsampling_and_base64_payload_retention_are_unmeasured"));
  assert.ok(report.limitations.includes("twenty_page_single_pdf_and_one_thousand_page_ordinary_pdf_are_unmeasured"));
  const output = JSON.stringify(report);
  for (const disallowed of [tmpdir(), "SYNTHETIC CAPACITY FORM", "schoolpilot_dev", "storageKey", "DATABASE_URL", "ANTHROPIC_API_KEY"]) {
    assert.ok(!output.includes(disallowed));
  }
  assert.deepEqual(await scratchDirectories(), before);
});

test("deadline cancellation drains or kills the owned child tree and removes all temporary content", { timeout: 30_000 }, async () => {
  const before = await scratchDirectories(), started = Date.now();
  const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs(["--scenario", "max", "--deadline-seconds", "1"]), portableReaders);
  assert.equal(report.status, "failed");
  assert.equal(report.failureCode, "DEADLINE");
  assert.equal(report.productionReadinessEstablished, false);
  assert.ok(Date.now() - started < 25_000);
  assert.deepEqual(await scratchDirectories(), before);
});

test("loss of memory usage while processing cancels the child and cleans its temporary files", { timeout: 30_000 }, async () => {
  const before = await scratchDirectories(); let samples = 0;
  const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs([]), {
    cgroup: async () => ++samples === 1 ? fixtureMemory : { ...fixtureMemory, current: null }, taskMemory: async () => null,
  });
  assert.equal(report.status, "failed"); assert.equal(report.failureCode, "MEMORY_UNAVAILABLE");
  assert.equal(report.processingHeadroomBelow70Percent, null);
  assert.deepEqual(await scratchDirectories(), before);
});

test("task-memory pressure cancels processing even when cgroup v1 has no finite limit", { timeout: 30_000 }, async () => {
  const before = await scratchDirectories(); let samples = 0;
  const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs([]), {
    cgroup: async () => ({ current: (++samples === 1 ? 100 : 440) * MiB, peak: 440 * MiB, limit: null, version: "v1" }),
    taskMemory: async () => 512 * MiB,
  });
  assert.equal(report.status, "failed"); assert.equal(report.failureCode, "MEMORY_STOP");
  assert.equal(report.memory.effectiveLimitBytes, 512 * MiB); assert.equal(report.memory.cgroupLimitBytes, null);
  assert.equal(report.memory.observedCgroupPeakFraction, 440 / 512);
  assert.equal(report.processingHeadroomBelow70Percent, null);
  assert.deepEqual(await scratchDirectories(), before);
});

test("a missing later cgroup limit cannot relax the smaller bound already verified", { timeout: 30_000 }, async () => {
  const before = await scratchDirectories(); let samples = 0;
  const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs([]), {
    cgroup: async () => ++samples === 1
      ? { current: 100 * MiB, peak: 100 * MiB, limit: 256 * MiB, version: "v1" }
      : { current: 220 * MiB, peak: 220 * MiB, limit: null, version: "v1" },
    taskMemory: async () => 512 * MiB,
  });
  assert.equal(report.failureCode, "MEMORY_STOP"); assert.equal(report.memory.effectiveLimitBytes, 256 * MiB);
  assert.equal(report.memory.effectiveLimitSource, "cgroup"); assert.equal(report.memory.cgroupLimitBytes, null);
  assert.equal(report.memory.observedCgroupPeakFraction, 220 / 256);
  assert.deepEqual(await scratchDirectories(), before);
});
