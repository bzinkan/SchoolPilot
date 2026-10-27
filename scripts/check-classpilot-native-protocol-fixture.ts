import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NATIVE_LIMITS } from "../src/services/classpilotNativeProtocol.js";

const file = process.argv[2];
if (!file) throw new Error("Pass the ClassPilotDesktop protocol/fixtures/observed-policy.json path");
const fixture = JSON.parse(await readFile(file, "utf8"));
assert.equal(fixture.captureAllowed, true);
assert.equal(fixture.intervalSeconds, NATIVE_LIMITS.captureSeconds);
assert.equal(fixture.maxWidth, NATIVE_LIMITS.maxWidth);
assert.equal(fixture.maxHeight, NATIVE_LIMITS.maxHeight);
assert.equal(fixture.maxBytes, NATIVE_LIMITS.maxBytes);
assert.equal(Date.parse(fixture.expiresAt) - Date.parse(fixture.serverTime), NATIVE_LIMITS.leaseMs);
assert.equal(fixture.expiresInSeconds * 1000, NATIVE_LIMITS.leaseMs);
assert.ok(Number.isSafeInteger(fixture.bindingRevision) && fixture.bindingRevision > 0);
console.log("Shared native protocol fixture matches SchoolPilot limits.");
