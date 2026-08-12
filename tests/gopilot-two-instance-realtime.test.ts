import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { sql } from "drizzle-orm";
import db, { pool } from "../src/db.js";
import { runWithTenantContext } from "../src/middleware/tenantContext.js";
import {
  createHomeroomWithPrimaryTeacher,
  createMembership,
  createParentStudentLink,
  createProductLicense,
  createSchool,
  createStudent,
  createUser,
} from "../src/services/storage.js";

const redisUrl = process.env.TEST_REDIS_URL;
const fixturePath = fileURLToPath(
  new URL("./fixtures/gopilot-socket-instance.ts", import.meta.url)
);

type FixtureMessage = {
  id?: string;
  type: string;
  ok?: boolean;
  error?: string;
  port?: number;
  result?: { size?: number };
  state?: {
    httpListening: boolean;
    socketCount: number;
    redisConnected: boolean;
    redisSubscribed: boolean;
  };
};

type FixtureHarness = {
  child: ChildProcess;
  output: () => string;
};

function waitForChildMessage(
  harness: FixtureHarness,
  predicate: (message: FixtureMessage) => boolean,
  timeoutMs = 10_000
): Promise<FixtureMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for socket fixture. Output:\n${harness.output()}`));
    }, timeoutMs);
    const onMessage = (message: FixtureMessage) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Socket fixture exited before its response (code=${code}, signal=${signal}). Output:\n${harness.output()}`
        )
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      harness.child.off("message", onMessage);
      harness.child.off("exit", onExit);
    };
    harness.child.on("message", onMessage);
    harness.child.once("exit", onExit);
  });
}

function startFixture(env: NodeJS.ProcessEnv): FixtureHarness {
  let output = "";
  const child = fork(fixturePath, [], {
    env,
    execArgv: ["--import", "tsx"],
    silent: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8_000);
    });
  }
  return { child, output: () => output };
}

async function requestFixture(
  harness: FixtureHarness,
  command: Record<string, unknown>,
  expectedType = "response"
): Promise<FixtureMessage> {
  const id = randomUUID();
  const response = waitForChildMessage(
    harness,
    (message) => message.id === id && message.type === expectedType
  );
  harness.child.send({ ...command, id });
  const message = await response;
  if (message.ok === false) {
    throw new Error(message.error || "Socket fixture command failed");
  }
  return message;
}

async function waitForRoom(
  harness: FixtureHarness,
  room: string,
  expectedSize: number
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await requestFixture(harness, { type: "inspect-room", room });
    if (response.result?.size === expectedSize) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Room ${room} did not reach size ${expectedSize}`);
}

function connectStaffSocket(port: number, token: string): Promise<Socket> {
  const socket = createSocketClient(`http://127.0.0.1:${port}`, {
    path: "/gopilot-socket",
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    timeout: 5_000,
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Timed out connecting to GoPilot Socket.IO fixture"));
    }, 7_500);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(error);
    });
  });
}

async function deniedSocketResult(port: number, token: string) {
  const socket = createSocketClient(`http://127.0.0.1:${port}`, {
    path: "/gopilot-socket",
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    autoConnect: false,
    timeout: 5_000,
  });
  try {
    const error = await new Promise<Error & { data?: { code?: string; status?: number } }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.disconnect();
          reject(new Error("Timed out waiting for rejected GoPilot socket"));
        }, 7_500);
        socket.once("connect", () => {
          clearTimeout(timeout);
          reject(new Error("Retired GoPilot parent socket unexpectedly connected"));
        });
        socket.once("connect_error", (connectionError) => {
          clearTimeout(timeout);
          resolve(connectionError as Error & { data?: { code?: string; status?: number } });
        });
        socket.connect();
      }
    );
    return {
      message: error.message,
      code: error.data?.code,
      status: error.data?.status,
    };
  } finally {
    socket.disconnect();
    assert.equal(socket.connected, false);
  }
}

function tokenFor(secret: string, user: { id: string; email: string }): string {
  return jwt.sign({ userId: user.id, email: user.email }, secret, {
    algorithm: "HS256",
    expiresIn: "10m",
  });
}

async function shutdownFixture(harness: FixtureHarness): Promise<FixtureMessage> {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => harness.child.once("exit", (code, signal) => resolve({ code, signal }))
  );
  const result = await requestFixture(harness, { type: "shutdown" }, "shutdown-complete");
  const exit = await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Socket fixture left active handles. Output:\n${harness.output()}`)), 5_000)
    ),
  ]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(harness.child.connected, false);
  assert.equal(harness.child.exitCode, 0);
  return result;
}

test(
  "GoPilot relays one event exactly once between two real API socket instances",
  { skip: !redisUrl, timeout: 45_000 },
  async () => {
    const tag = `gopilot_socket_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const domain = `${tag}.example.edu`;
    const jwtSecret = `test-${randomUUID()}-${randomUUID()}`;
    const sockets: Socket[] = [];
    const fixtures: FixtureHarness[] = [];
    let school: Awaited<ReturnType<typeof createSchool>> | undefined;
    const userIds: string[] = [];

    try {
      school = await createSchool({
        name: tag,
        domain,
        slug: tag.replaceAll("_", "-"),
      });
      const [office, teacher, parentWithChild, parentWithoutChild] = await Promise.all([
        createUser({ email: `office@${domain}`, firstName: "Office", lastName: "Staff" }),
        createUser({ email: `teacher@${domain}`, firstName: "Assigned", lastName: "Teacher" }),
        createUser({ email: `linked-parent@${domain}`, firstName: "Linked", lastName: "Parent" }),
        createUser({ email: `unlinked-parent@${domain}`, firstName: "Unlinked", lastName: "Parent" }),
      ]);
      userIds.push(office.id, teacher.id, parentWithChild.id, parentWithoutChild.id);

      await createProductLicense({
        schoolId: school.id,
        product: "GOPILOT",
        status: "active",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await runWithTenantContext({ schoolId: school.id }, async () => {
        await Promise.all([
          createMembership({ userId: office.id, schoolId: school!.id, role: "office_staff", status: "active" }),
          createMembership({ userId: teacher.id, schoolId: school!.id, role: "teacher", status: "active" }),
          createMembership({ userId: parentWithChild.id, schoolId: school!.id, role: "parent", status: "active" }),
          createMembership({ userId: parentWithoutChild.id, schoolId: school!.id, role: "parent", status: "active" }),
        ]);
      });
      const homeroom = await runWithTenantContext({ schoolId: school.id }, () =>
        createHomeroomWithPrimaryTeacher({
          schoolId: school!.id,
          teacherId: teacher.id,
          name: "Test Homeroom",
          grade: "4",
        })
      );
      const student = await runWithTenantContext({ schoolId: school.id }, () =>
        createStudent({
          schoolId: school!.id,
          firstName: "Synthetic",
          lastName: "Student",
          homeroomId: homeroom.id,
          dismissalType: "car",
          status: "active",
        })
      );
      await runWithTenantContext({ schoolId: school.id }, () =>
        createParentStudentLink({
          schoolId: school!.id,
          parentId: parentWithChild.id,
          studentId: student.id,
          relationship: "guardian",
          status: "approved",
        })
      );

      const redisPrefix = `${tag}:relay`;
      const fixtureEnv = {
        ...process.env,
        REDIS_URL: redisUrl,
        REDIS_PREFIX: redisPrefix,
        JWT_SECRET: jwtSecret,
        RUN_MIGRATIONS_ON_STARTUP: "false",
        SCHEDULER_ENABLED: "false",
      };
      const first = startFixture(fixtureEnv);
      const second = startFixture(fixtureEnv);
      fixtures.push(first, second);
      const [firstReady, secondReady] = await Promise.all([
        waitForChildMessage(first, (message) => message.type === "ready"),
        waitForChildMessage(second, (message) => message.type === "ready"),
      ]);
      assert.equal(typeof firstReady.port, "number");
      assert.equal(typeof secondReady.port, "number");

      const [officeSocket, teacherSocket] = await Promise.all([
        connectStaffSocket(firstReady.port!, tokenFor(jwtSecret, office)),
        connectStaffSocket(secondReady.port!, tokenFor(jwtSecret, teacher)),
      ]);
      sockets.push(officeSocket, teacherSocket);
      const officeEvents: unknown[] = [];
      const teacherEvents: unknown[] = [];
      officeSocket.on("student:checked-in", (payload) => officeEvents.push(payload));
      teacherSocket.on("student:checked-in", (payload) => teacherEvents.push(payload));

      officeSocket.emit("join:school", { schoolId: school.id });
      teacherSocket.emit("join:school", { schoolId: school.id, homeroomId: homeroom.id });
      await Promise.all([
        waitForRoom(first, `school:${school.id}`, 1),
        waitForRoom(first, `school:${school.id}:office`, 1),
        waitForRoom(second, `school:${school.id}`, 1),
        waitForRoom(second, `school:${school.id}:teacher:${homeroom.id}`, 1),
      ]);

      const payload = { queueId: `synthetic-${randomUUID()}`, source: "staff_search" };
      await requestFixture(first, {
        type: "broadcast",
        room: `school:${school.id}`,
        event: "student:checked-in",
        data: payload,
      });
      const deliveryDeadline = Date.now() + 5_000;
      while (
        (officeEvents.length < 1 || teacherEvents.length < 1) &&
        Date.now() < deliveryDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.deepEqual(officeEvents, [payload], "local office client receives the event once");
      assert.deepEqual(teacherEvents, [payload], "remote teacher client receives the Redis-relayed event once");

      const linkedParentDenial = await deniedSocketResult(
        firstReady.port!,
        tokenFor(jwtSecret, parentWithChild)
      );
      const unlinkedParentDenial = await deniedSocketResult(
        secondReady.port!,
        tokenFor(jwtSecret, parentWithoutChild)
      );
      assert.deepEqual(linkedParentDenial, {
        message: "GoPilot parent portal is disabled",
        code: "GOPILOT_PARENT_PORTAL_DISABLED",
        status: 410,
      });
      assert.deepEqual(
        unlinkedParentDenial,
        linkedParentDenial,
        "parent socket denial must not reveal whether an approved child link exists"
      );

      for (const socket of sockets) {
        socket.disconnect();
        assert.equal(socket.connected, false);
      }
      await Promise.all([
        waitForRoom(first, `school:${school.id}`, 0),
        waitForRoom(second, `school:${school.id}`, 0),
      ]);
      const shutdownStates = await Promise.all(fixtures.map(shutdownFixture));
      for (const shutdownState of shutdownStates) {
        assert.deepEqual(shutdownState.state, {
          httpListening: false,
          socketCount: 0,
          redisConnected: false,
          redisSubscribed: false,
        });
      }
      fixtures.length = 0;
    } finally {
      for (const socket of sockets) socket.disconnect();
      for (const fixture of fixtures) {
        if (!fixture.child.killed && fixture.child.exitCode === null) {
          fixture.child.kill("SIGTERM");
        }
      }
      await Promise.all(
        fixtures.map(
          (fixture) =>
            new Promise<void>((resolve) => {
              if (fixture.child.exitCode !== null) return resolve();
              fixture.child.once("exit", () => resolve());
              setTimeout(() => {
                if (fixture.child.exitCode === null) fixture.child.kill("SIGKILL");
              }, 2_000).unref?.();
            })
        )
      );

      if (school) {
        await runWithTenantContext({ isSuper: true }, async () => {
          await db.execute(sql`DELETE FROM parent_student WHERE school_id = ${school!.id}`);
          await db.execute(sql`DELETE FROM homeroom_teachers WHERE school_id = ${school!.id}`);
          await db.execute(sql`DELETE FROM homerooms WHERE school_id = ${school!.id}`);
          await db.execute(sql`DELETE FROM students WHERE school_id = ${school!.id}`);
          await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school!.id}`);
          await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school!.id}`);
          await db.execute(sql`DELETE FROM schools WHERE id = ${school!.id}`);
          if (userIds.length > 0) {
            await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
          }
        });
      }
      await pool.end();
    }
  }
);
