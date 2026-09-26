import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { parseMyDeskMeasurementArgs, padSyntheticPdf, measureMyDeskProcessing } from "../src/cli/measureMyDeskProcessing.js";
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

test("isolated smoke exercises both jobs, ordinary uploads and continuation PDFs without exposing content or claiming readiness", { timeout: 100_000 }, async () => {
  const before = await scratchDirectories();
  const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs(["--image-digest", `sha256:${"a".repeat(64)}`]));
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
  const output = JSON.stringify(report);
  for (const disallowed of [tmpdir(), "SYNTHETIC CAPACITY FORM", "schoolpilot_dev", "storageKey", "DATABASE_URL", "ANTHROPIC_API_KEY"]) {
    assert.ok(!output.includes(disallowed));
  }
  assert.deepEqual(await scratchDirectories(), before);
});

test("deadline cancellation drains or kills the owned child tree and removes all temporary content", { timeout: 30_000 }, async () => {
  const before = await scratchDirectories(), started = Date.now();
  const report = await measureMyDeskProcessing(parseMyDeskMeasurementArgs(["--scenario", "max", "--deadline-seconds", "1"]));
  assert.equal(report.status, "failed");
  assert.equal(report.failureCode, "DEADLINE");
  assert.equal(report.productionReadinessEstablished, false);
  assert.ok(Date.now() - started < 25_000);
  assert.deepEqual(await scratchDirectories(), before);
});
