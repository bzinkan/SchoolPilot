import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import session from "express-session";
import { clearSessionCookie, sessionCookieName, sessionCookieOptions } from "../src/config/sessionCookie.js";

const production = { NODE_ENV: "production", APP_ENV: "production", COOKIE_DOMAIN: ".school-pilot.example" };
const staging = { NODE_ENV: "production", APP_ENV: "staging", COOKIE_NAME: "schoolpilot.staging.sid", COOKIE_DOMAIN: "" };

test("production cookie defaults and expiry scope stay compatible while staging is explicitly host-only", () => {
  assert.equal(sessionCookieName(production), "schoolpilot.sid");
  assert.deepEqual(sessionCookieOptions(production), {
    maxAge: 7 * 24 * 60 * 60 * 1_000, httpOnly: true, secure: true,
    sameSite: "lax", domain: ".school-pilot.example", path: "/",
  });
  assert.equal(sessionCookieName(staging), "schoolpilot.staging.sid");
  assert.deepEqual(sessionCookieOptions(staging), {
    maxAge: 7 * 24 * 60 * 60 * 1_000, httpOnly: true, secure: true,
    sameSite: "lax", domain: undefined, path: "/",
  });
});

test("staging rejects production session names and parent domains, and malformed names never enter cookie headers", () => {
  assert.throws(() => sessionCookieName({ APP_ENV: "staging" }), /distinct COOKIE_NAME/);
  assert.throws(() => sessionCookieName({ ...staging, COOKIE_NAME: "schoolpilot.sid" }), /distinct COOKIE_NAME/);
  assert.throws(() => sessionCookieOptions({ ...staging, COOKIE_DOMAIN: ".school-pilot.example" }), /host-only/);
  for (const name of ["private-cookie; Domain=example.invalid", "private-cookie\r\n", " ", "x".repeat(129)]) {
    assert.throws(() => sessionCookieName({ COOKIE_NAME: name }), error =>
      error instanceof Error && /valid cookie name/.test(error.message) && !error.message.includes("private-cookie"));
  }
});

// Each middleware owns its store.generate function, as separate processes would,
// while these views deliberately share every stored session and the signing key.
class SessionStoreView extends session.Store {
  constructor(private readonly backing: session.MemoryStore) { super(); }
  get(id: string, callback: (error: unknown, data?: session.SessionData | null) => void) {
    this.backing.get(id, callback);
  }
  set(id: string, data: session.SessionData, callback?: (error?: unknown) => void) {
    this.backing.set(id, data, callback);
  }
  destroy(id: string, callback?: (error?: unknown) => void) { this.backing.destroy(id, callback); }
}

async function fixture(env: NodeJS.ProcessEnv, store: session.Store, identity: string) {
  const app = express();
  app.set("trust proxy", true);
  app.use(session({ name: sessionCookieName(env), cookie: sessionCookieOptions(env), store,
    secret: "synthetic-cookie-isolation-fixture-only", resave: false, saveUninitialized: false }));
  app.post("/login", (req, res, next) => {
    req.session.userId = identity;
    req.session.save(error => error ? next(error) : res.sendStatus(204));
  });
  app.get("/identity", (req, res) => { res.json({ userId: req.session.userId ?? null }); });
  app.post("/logout", (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      clearSessionCookie(res, env);
      res.sendStatus(204);
    });
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    request: (path: string, cookie = "", method = "GET") => fetch(`${base}${path}`, {
      method, headers: { "x-forwarded-proto": "https", ...(cookie ? { cookie } : {}) },
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    }),
  };
}

test("real session middleware ignores another environment's cookie even with a shared signing key and store", async () => {
  const store = new session.MemoryStore();
  const prod = await fixture(production, new SessionStoreView(store), "synthetic-production-user");
  const stage = await fixture(staging, new SessionStoreView(store), "synthetic-staging-user");
  try {
    const prodCookie = (await prod.request("/login", "", "POST")).headers.get("set-cookie")!;
    const stageCookie = (await stage.request("/login", "", "POST")).headers.get("set-cookie")!;
    assert.match(prodCookie, /^schoolpilot\.sid=/);
    assert.match(prodCookie, /Domain=\.school-pilot\.example/);
    assert.match(stageCookie, /^schoolpilot\.staging\.sid=/);
    assert.match(stageCookie, /; Path=\/.*; HttpOnly; Secure; SameSite=Lax/);
    assert.doesNotMatch(stageCookie, /Domain=/);
    const productionPair = prodCookie.split(";")[0]!;
    const stagingPair = stageCookie.split(";")[0]!;
    assert.deepEqual(await (await stage.request("/identity", productionPair)).json(), { userId: null });
    assert.deepEqual(await (await prod.request("/identity", stagingPair)).json(), { userId: null });
    const combined = `${productionPair}; ${stagingPair}`;
    assert.deepEqual(await (await stage.request("/identity", combined)).json(), { userId: "synthetic-staging-user" });
    assert.deepEqual(await (await prod.request("/identity", combined)).json(), { userId: "synthetic-production-user" });
    const logout = await stage.request("/logout", combined, "POST");
    const cleared = logout.headers.getSetCookie();
    assert.equal(cleared.length, 1);
    assert.match(cleared[0]!, /^schoolpilot\.staging\.sid=; Path=\/; Expires=Thu, 01 Jan 1970/);
    assert.doesNotMatch(cleared[0]!, /Domain=|Max-Age=|^schoolpilot\.sid=/);
    assert.deepEqual(await (await prod.request("/identity", combined)).json(), { userId: "synthetic-production-user" });
    assert.deepEqual(await (await stage.request("/identity", combined)).json(), { userId: null });
  } finally { await Promise.all([prod.close(), stage.close()]); store.clear(() => {}); }
});

test("production logout clears only its original scoped cookie and leaves staging sessions usable", async () => {
  const store = new session.MemoryStore();
  const prod = await fixture(production, new SessionStoreView(store), "synthetic-production-user");
  const stage = await fixture(staging, new SessionStoreView(store), "synthetic-staging-user");
  try {
    const prodCookie = (await prod.request("/login", "", "POST")).headers.get("set-cookie")!.split(";")[0]!;
    const stageCookie = (await stage.request("/login", "", "POST")).headers.get("set-cookie")!.split(";")[0]!;
    const combined = `${stageCookie}; ${prodCookie}`;
    const cleared = (await prod.request("/logout", combined, "POST")).headers.getSetCookie();
    assert.equal(cleared.length, 1);
    assert.match(cleared[0]!, /^schoolpilot\.sid=; Domain=\.school-pilot\.example; Path=\/; Expires=Thu, 01 Jan 1970/);
    assert.doesNotMatch(cleared[0]!, /^schoolpilot\.staging\.sid=/);
    assert.deepEqual(await (await stage.request("/identity", combined)).json(), { userId: "synthetic-staging-user" });
  } finally { await Promise.all([prod.close(), stage.close()]); store.clear(() => {}); }
});
