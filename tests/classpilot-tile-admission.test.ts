import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  AdmissionGateError,
  CLASSPILOT_TILE_MAX_ACTIVE,
  classPilotTileMaxActiveForPool,
  classPilotTileAdmission,
  createAdmissionGate,
  releaseClassPilotTileAdmission,
} from "../src/middleware/classpilotTileAdmission.ts";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function isAdmissionError(code: AdmissionGateError["code"]) {
  return (error: unknown): boolean =>
    error instanceof AdmissionGateError && error.code === code;
}

type MiddlewareInvocation = {
  req: EventEmitter & { aborted: boolean };
  res: EventEmitter & {
    destroyed: boolean;
    locals: Record<string, unknown>;
    statusCode: number;
    setHeader(name: string, value: string): void;
    status(code: number): MiddlewareInvocation["res"];
    json(body: unknown): unknown;
  };
  completion: Promise<void>;
  nextCalls: number;
  nextErrors: unknown[];
};

function invokeTileAdmission(): MiddlewareInvocation {
  const req = Object.assign(new EventEmitter(), { aborted: false });
  const headers = new Map<string, string>();
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    locals: {} as Record<string, unknown>,
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      return body;
    },
  }) as MiddlewareInvocation["res"];
  const invocation = {
    req,
    res,
    completion: Promise.resolve(),
    nextCalls: 0,
    nextErrors: [] as unknown[],
  } as MiddlewareInvocation;
  invocation.completion = Promise.resolve(
    classPilotTileAdmission(req as any, res as any, (error?: unknown) => {
      invocation.nextCalls += 1;
      if (error !== undefined) invocation.nextErrors.push(error);
    })
  ).then(() => undefined);
  return invocation;
}

function finishInvocation(invocation: MiddlewareInvocation, event: "finish" | "close") {
  if (event === "close") invocation.res.destroyed = true;
  invocation.res.emit(event);
}

describe("ClassPilot tile admission gate", () => {
  it("reserves non-tile connections across supported main-pool sizes", () => {
    assert.equal(classPilotTileMaxActiveForPool(18), 10);
    assert.equal(classPilotTileMaxActiveForPool(12), 7);
    assert.equal(classPilotTileMaxActiveForPool(5), 3);
    assert.equal(classPilotTileMaxActiveForPool(2), 1);
    assert.equal(classPilotTileMaxActiveForPool(1), 1);
    assert.throws(() => classPilotTileMaxActiveForPool(0), RangeError);
  });

  it("admits queued work in FIFO order without exceeding the active limit", async () => {
    const gate = createAdmissionGate({
      maxActive: 1,
      maxQueued: 4,
      waitTimeoutMs: 1_000,
    });
    const firstRelease = await gate.acquire();
    const order: string[] = [];

    const second = gate.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = gate.acquire().then((release) => {
      order.push("third");
      return release;
    });
    await nextTurn();

    assert.deepEqual(order, []);
    assert.deepEqual(
      { active: gate.snapshot().active, queued: gate.snapshot().queued },
      { active: 1, queued: 2 }
    );

    firstRelease();
    const secondRelease = await second;
    await nextTurn();
    assert.deepEqual(order, ["second"]);
    assert.deepEqual(
      { active: gate.snapshot().active, queued: gate.snapshot().queued },
      { active: 1, queued: 1 }
    );

    secondRelease();
    const thirdRelease = await third;
    assert.deepEqual(order, ["second", "third"]);
    assert.equal(gate.snapshot().maxObservedActive, 1);

    thirdRelease();
    assert.deepEqual(
      { active: gate.snapshot().active, queued: gate.snapshot().queued },
      { active: 0, queued: 0 }
    );
  });

  it("makes releases idempotent and dispatches only one queued permit", async () => {
    const gate = createAdmissionGate({
      maxActive: 1,
      maxQueued: 3,
      waitTimeoutMs: 1_000,
    });
    const firstRelease = await gate.acquire();
    let secondAdmissions = 0;
    const second = gate.acquire().then((release) => {
      secondAdmissions += 1;
      return release;
    });

    firstRelease();
    firstRelease();
    const secondRelease = await second;

    assert.equal(secondAdmissions, 1);
    assert.equal(gate.snapshot().active, 1);
    assert.equal(gate.snapshot().admitted, 2);

    secondRelease();
    secondRelease();
    assert.equal(gate.snapshot().active, 0);
  });

  it("removes an aborted waiter without blocking the next FIFO request", async () => {
    const gate = createAdmissionGate({
      maxActive: 1,
      maxQueued: 3,
      waitTimeoutMs: 1_000,
    });
    const firstRelease = await gate.acquire();
    const controller = new AbortController();
    const aborted = gate.acquire(controller.signal);
    const next = gate.acquire();

    controller.abort();
    await assert.rejects(aborted, isAdmissionError("admission_aborted"));
    assert.equal(gate.snapshot().queued, 1);

    firstRelease();
    const nextRelease = await next;
    assert.equal(gate.snapshot().active, 1);
    assert.equal(gate.snapshot().aborted, 1);

    nextRelease();
    assert.equal(gate.snapshot().active, 0);
  });

  it("times out queued work, reports saturation, and never leaks a permit", async () => {
    const gate = createAdmissionGate({
      maxActive: 1,
      maxQueued: 1,
      waitTimeoutMs: 20,
    });
    const firstRelease = await gate.acquire();
    const timedOut = gate.acquire();

    await assert.rejects(
      gate.acquire(),
      isAdmissionError("admission_queue_full")
    );

    // The production timeout is deliberately unref'd. Keep this unit-test
    // worker alive until the timeout has had a chance to settle.
    const keepAlive = setTimeout(() => {}, 250);
    try {
      await assert.rejects(timedOut, isAdmissionError("admission_timeout"));
    } finally {
      clearTimeout(keepAlive);
    }

    assert.deepEqual(
      {
        active: gate.snapshot().active,
        queued: gate.snapshot().queued,
        timedOut: gate.snapshot().timedOut,
        queueFull: gate.snapshot().queueFull,
      },
      { active: 1, queued: 0, timedOut: 1, queueFull: 1 }
    );

    firstRelease();
    assert.equal(gate.snapshot().active, 0);
  });
});

describe("ClassPilot tile admission middleware lifecycle", () => {
  it("can release after the protected database section before response finish", async () => {
    const active: MiddlewareInvocation[] = [];
    let queued: MiddlewareInvocation | undefined;
    try {
      for (let index = 0; index < CLASSPILOT_TILE_MAX_ACTIVE; index += 1) {
        const invocation = invokeTileAdmission();
        await invocation.completion;
        active.push(invocation);
      }

      queued = invokeTileAdmission();
      await nextTurn();
      assert.equal(queued.nextCalls, 0);

      releaseClassPilotTileAdmission(active[0]!.res as any);
      await queued.completion;
      assert.equal(queued.nextCalls, 1);
      assert.equal(active[0]!.res.listenerCount("finish"), 0);
      assert.equal(active[0]!.res.listenerCount("close"), 0);
    } finally {
      for (const invocation of [...active, ...(queued ? [queued] : [])]) {
        finishInvocation(invocation, "finish");
      }
    }
  });

  it("releases permits on both response finish and response close", async () => {
    const active: MiddlewareInvocation[] = [];
    const admittedAfterRelease: MiddlewareInvocation[] = [];
    try {
      for (let index = 0; index < CLASSPILOT_TILE_MAX_ACTIVE; index += 1) {
        const invocation = invokeTileAdmission();
        await invocation.completion;
        assert.equal(invocation.nextCalls, 1);
        active.push(invocation);
      }

      const afterFinish = invokeTileAdmission();
      admittedAfterRelease.push(afterFinish);
      await nextTurn();
      assert.equal(afterFinish.nextCalls, 0);
      finishInvocation(active[0]!, "finish");
      await afterFinish.completion;
      assert.equal(afterFinish.nextCalls, 1);

      const afterClose = invokeTileAdmission();
      admittedAfterRelease.push(afterClose);
      await nextTurn();
      assert.equal(afterClose.nextCalls, 0);
      finishInvocation(afterFinish, "close");
      await afterClose.completion;
      assert.equal(afterClose.nextCalls, 1);
    } finally {
      for (const invocation of [...active, ...admittedAfterRelease]) {
        finishInvocation(invocation, "finish");
      }
    }
  });

  it("releases a dispatched permit when close wins the continuation race", async () => {
    const active: MiddlewareInvocation[] = [];
    let raced: MiddlewareInvocation | undefined;
    let replacement: MiddlewareInvocation | undefined;
    try {
      for (let index = 0; index < CLASSPILOT_TILE_MAX_ACTIVE; index += 1) {
        const invocation = invokeTileAdmission();
        await invocation.completion;
        assert.equal(invocation.nextCalls, 1);
        active.push(invocation);
      }

      raced = invokeTileAdmission();
      await nextTurn();
      assert.equal(raced.nextCalls, 0);

      // Releasing one active response dispatches the waiter synchronously, but
      // its async middleware continuation runs in a later microtask. Close the
      // response in that exact gap to exercise the leak-prevention branch.
      finishInvocation(active[0]!, "finish");
      finishInvocation(raced, "close");
      await raced.completion;
      assert.equal(raced.nextCalls, 0);

      replacement = invokeTileAdmission();
      await replacement.completion;
      assert.equal(
        replacement.nextCalls,
        1,
        "the raced request must release its dispatched permit"
      );
      assert.deepEqual(replacement.nextErrors, []);
    } finally {
      for (const invocation of [
        ...active,
        ...(raced ? [raced] : []),
        ...(replacement ? [replacement] : []),
      ]) {
        finishInvocation(invocation, "finish");
      }
    }
  });
});
