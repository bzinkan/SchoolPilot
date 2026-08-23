import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safetyAlertDisplayDomain } from "../src/services/email.js";

describe("ClassPilot safety email privacy", () => {
  it("reduces sensitive URLs to a normalized domain", () => {
    assert.equal(
      safetyAlertDisplayDomain("https://www.Example.edu/private/student?q=secret#fragment"),
      "example.edu"
    );
  });

  it("does not echo malformed or non-web values", () => {
    assert.equal(safetyAlertDisplayDomain("javascript:private-data"), "Unavailable");
    assert.equal(safetyAlertDisplayDomain("not a domain / private"), "Unavailable");
  });
});
