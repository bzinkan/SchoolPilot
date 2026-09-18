import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparePassword, hashPassword } from "../src/util/password.js";

// bcryptjs 3 writes $2b$ hashes; every stored $2a$ hash from bcryptjs 2 must keep verifying.
const LEGACY_2A_HASH = "$2a$04$FoVfAFQoNUfD9AB6o4jnXeKH.gmtJYwMxosNl97skihz/DP/P3PSG";
const PASSWORD = "correct horse battery staple";

describe("password hashing", () => {
  it("writes cost-12 $2b$ hashes that verify and reject a wrong password", async () => {
    const hash = await hashPassword(PASSWORD);
    assert.match(hash, /^\$2b\$12\$/);
    assert.equal(await comparePassword(PASSWORD, hash), true);
    assert.equal(await comparePassword(PASSWORD + "!", hash), false);
  });

  it("still verifies hashes written by bcryptjs 2 ($2a$)", async () => {
    assert.equal(await comparePassword(PASSWORD, LEGACY_2A_HASH), true);
    assert.equal(await comparePassword("wrong", LEGACY_2A_HASH), false);
  });
});
