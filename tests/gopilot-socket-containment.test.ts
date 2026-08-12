import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type Server as HttpServer } from "node:http";
import { after, before, describe, it } from "node:test";
import type { Server as SocketIoServer } from "socket.io";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import { setupSocketIO } from "../dist/realtime/socketio.js";
import { signUserToken } from "../dist/services/jwt.js";
import {
  createMembership,
  createProductLicense,
  createSchool,
  createUser,
} from "../dist/services/storage.js";

const requireFromFrontend = createRequire(
  new URL("../schoolpilot-app/package.json", import.meta.url)
);
const { io: createSocketClient } = requireFromFrontend("socket.io-client") as {
  io: (url: string, options: Record<string, unknown>) => any;
};

const TAG = `gopilot_socket_${Date.now()}`;
let school: any;
let retainedParent: any;
let teacher: any;
let httpServer: HttpServer;
let socketServer: SocketIoServer;
let baseUrl: string;

function asSystem<T>(operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, operation);
}

function tokenFor(user: any): string {
  return signUserToken({ userId: user.id, email: user.email, isSuperAdmin: false });
}

function nextEvent<T>(socket: any, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value: T) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

before(async () => {
  school = await createSchool({
    name: TAG,
    domain: `${TAG}.example.edu`,
    slug: TAG,
    status: "active",
  } as any);
  retainedParent = await createUser({
    email: `parent@${TAG}.example.edu`,
    firstName: "Retained",
    lastName: "Parent",
  } as any);
  teacher = await createUser({
    email: `teacher@${TAG}.example.edu`,
    firstName: "Expired",
    lastName: "Teacher",
  } as any);
  await asSystem(async () => {
    await createMembership({
      schoolId: school.id,
      userId: retainedParent.id,
      role: "admin",
      gopilotRole: "parent",
      status: "active",
    } as any);
    await createMembership({
      schoolId: school.id,
      userId: teacher.id,
      role: "teacher",
      gopilotRole: "teacher",
      status: "active",
    } as any);
    await createProductLicense({
      schoolId: school.id,
      product: "GOPILOT",
      status: "active",
      expiresAt: new Date(Date.now() - 60_000),
    } as any);
  });

  httpServer = createServer();
  socketServer = setupSocketIO(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Socket test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  if (httpServer.listening) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  await asSystem(async () => {
    await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${retainedParent.id}, ${teacher.id})`);
  });
  await pool.end();
});

describe("GoPilot socket containment", { concurrency: false }, () => {
  it("rejects an effective parent during the handshake with the stable 410 code", async () => {
    const socket = createSocketClient(baseUrl, {
      path: "/gopilot-socket",
      transports: ["websocket"],
      auth: { token: tokenFor(retainedParent) },
      forceNew: true,
      reconnection: false,
      timeout: 2_000,
    });
    try {
      const error = await nextEvent<any>(socket, "connect_error");
      assert.equal(error.message, "GoPilot parent portal is disabled");
      assert.equal(error.data?.code, "GOPILOT_PARENT_PORTAL_DISABLED");
      assert.equal(error.data?.status, 410);
      assert.equal(socket.connected, false);
    } finally {
      socket.close();
    }
  });

  it("lets retained staff authenticate but denies joining an expired-license school", async () => {
    const socket = createSocketClient(baseUrl, {
      path: "/gopilot-socket",
      transports: ["websocket"],
      auth: { token: tokenFor(teacher) },
      forceNew: true,
      reconnection: false,
      timeout: 2_000,
    });
    try {
      await nextEvent(socket, "connect");
      const denied = nextEvent<any>(socket, "join:error");
      socket.emit("join:school", { schoolId: school.id, homeroomId: `${TAG}_missing` });
      assert.deepEqual(await denied, { error: "Product license required" });
    } finally {
      socket.close();
    }
  });
});
