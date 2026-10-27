import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ipKeyGenerator } from "express-rate-limit";

describe("rate-limit address parser compatibility", () => {
  it("keeps IPv4 and both IPv4-mapped IPv6 notations in the same bucket", () => {
    const expected = "192.0.2.9";
    assert.equal(ipKeyGenerator(expected), expected);
    assert.equal(ipKeyGenerator("::ffff:192.0.2.9"), expected);
    assert.equal(ipKeyGenerator("::ffff:c000:209"), expected);
  });

  it("groups IPv6 addresses within the default /56 without crossing its boundary", () => {
    const expected = "2001:db8:1234:ab00::/56";
    assert.equal(ipKeyGenerator("2001:db8:1234:ab01::1"), expected);
    assert.equal(ipKeyGenerator("2001:db8:1234:abff::2"), expected);
    assert.notEqual(ipKeyGenerator("2001:db8:1234:ac00::1"), expected);
  });

  it("respects a configured /64 and an explicitly disabled IPv6 subnet", () => {
    const ip = "2001:db8:1234:ab01::1";
    assert.equal(ipKeyGenerator(ip, 64), "2001:db8:1234:ab01::/64");
    assert.notEqual(ipKeyGenerator("2001:db8:1234:ab02::1", 64), ipKeyGenerator(ip, 64));
    assert.equal(ipKeyGenerator(ip, false), ip);
  });
});
