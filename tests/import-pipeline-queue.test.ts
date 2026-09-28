import { test } from "node:test";
import assert from "node:assert/strict";
import { runImportPipelineQueue, type ImportPipelineTask } from "../src/services/importPipelineQueue.js";
import { paperworkProcessingVersion, paperworkProcessingWidth } from "../src/config/paperworkProcessing.js";

test("ready forms start before remaining pages and never exceed the two-task bound", async () => {
  const order: string[] = [];
  let active = 0, peak = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const form: ImportPipelineTask = async () => { order.push("form"); release(); };
  await runImportPipelineQueue([
    async enqueue => { active++; peak = Math.max(peak, active); order.push("page1"); enqueue([form], true); active--; },
    async () => { active++; peak = Math.max(peak, active); order.push("page2"); await blocked; active--; },
    async () => { order.push("page3"); },
  ], 2);
  assert.ok(order.indexOf("form") < order.indexOf("page3"));
  assert.ok(peak <= 2);
});

test("a freed task slot refills without waiting for a slow sibling", async () => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  let refill = false;
  await runImportPipelineQueue([
    async () => { await slow; assert.equal(refill, true); },
    async () => {},
    async () => { refill = true; releaseSlow(); },
  ], 2);
});

test("cancellation drains started work without launching later tasks", async () => {
  const controller = new AbortController();
  let later = 0;
  await assert.rejects(runImportPipelineQueue([
    async () => { controller.abort(); },
    async () => { later++; },
  ], 1, controller.signal));
  assert.equal(later, 0);
});

test("pipeline gate defaults to legacy and rejects unknown values", () => {
  const version = process.env.MYDESK_IMPORT_PIPELINE_VERSION;
  const width = process.env.MYDESK_IMPORT_PIPELINE_WIDTH;
  try {
    delete process.env.MYDESK_IMPORT_PIPELINE_VERSION;
    delete process.env.MYDESK_IMPORT_PIPELINE_WIDTH;
    assert.equal(paperworkProcessingVersion(), 1);
    assert.equal(paperworkProcessingWidth(), 2);
    process.env.MYDESK_IMPORT_PIPELINE_VERSION = "2";
    process.env.MYDESK_IMPORT_PIPELINE_WIDTH = "1";
    assert.equal(paperworkProcessingVersion(), 2);
    assert.equal(paperworkProcessingWidth(), 1);
    process.env.MYDESK_IMPORT_PIPELINE_VERSION = "yes";
    assert.throws(paperworkProcessingVersion);
  } finally {
    if (version === undefined) delete process.env.MYDESK_IMPORT_PIPELINE_VERSION; else process.env.MYDESK_IMPORT_PIPELINE_VERSION = version;
    if (width === undefined) delete process.env.MYDESK_IMPORT_PIPELINE_WIDTH; else process.env.MYDESK_IMPORT_PIPELINE_WIDTH = width;
  }
});
