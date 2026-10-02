import assert from "node:assert/strict";
import { test } from "node:test";
import { ClasspilotUsageAdmission, ClasspilotUsageBusyError } from "../src/services/classpilotUsageAdmission.js";

const signal = () => new AbortController().signal;

test("Usage admits two tasks, one per school, and rotates waiting schools", async () => {
  const admission = new ClasspilotUsageAdmission();
  const a = await admission.acquire("a", signal());
  const b = await admission.acquire("b", signal());
  const order: string[] = [];
  const a2 = admission.acquire("a", signal()).then(release => { order.push("a2"); return release; });
  const a3 = admission.acquire("a", signal()).then(release => { order.push("a3"); return release; });
  const c = admission.acquire("c", signal()).then(release => { order.push("c"); return release; });
  assert.deepEqual(admission.snapshot(), { active: 2, queued: 3 });
  b();
  const releaseC = await c;
  assert.deepEqual(order, ["c"], "a queued school cannot occupy two execution slots");
  a();
  const releaseA2 = await a2;
  const d = admission.acquire("d", signal()).then(release => { order.push("d"); return release; });
  releaseA2();
  const releaseA3 = await a3;
  releaseC();
  const releaseD = await d;
  releaseA3(); releaseA3(); releaseD();
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0 });
});

test("Usage bounds waiting work to 16 per school and 32 per process", async () => {
  const admission = new ClasspilotUsageAdmission();
  const a = await admission.acquire("a", signal());
  const b = await admission.acquire("b", signal());
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const waiting = controllers.map((controller, index) => admission.acquire(index < 16 ? "a" : "b", controller.signal));
  await assert.rejects(admission.acquire("a", signal()), ClasspilotUsageBusyError);
  await assert.rejects(admission.acquire("c", signal()), ClasspilotUsageBusyError);
  const settled = Promise.allSettled(waiting);
  controllers.forEach(controller => controller.abort(new ClasspilotUsageBusyError()));
  assert.ok((await settled).every(result => result.status === "rejected"));
  assert.deepEqual(admission.snapshot(), { active: 2, queued: 0 });
  a(); b();
});

test("Usage cancellation removes queued work and never frees an active owner's permit", async () => {
  const admission = new ClasspilotUsageAdmission();
  const activeController = new AbortController();
  const release = await admission.acquire("a", activeController.signal);
  const waitingController = new AbortController();
  const waiting = admission.acquire("a", waitingController.signal);
  const rejection = assert.rejects(waiting, ClasspilotUsageBusyError);
  waitingController.abort(new ClasspilotUsageBusyError());
  await rejection;
  activeController.abort(new ClasspilotUsageBusyError());
  assert.deepEqual(admission.snapshot(), { active: 1, queued: 0 });
  release();
  await assert.rejects(admission.acquire("a", activeController.signal), ClasspilotUsageBusyError);
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0 });
});
