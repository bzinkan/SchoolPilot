import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertClasspilotCapabilityRolloutsEnv } from "../src/services/classpilotProtocol.js";

const FATAL = /FATAL: CLASSPILOT_CAPABILITY_ROLLOUTS_JSON/;

const VALID_MAP = JSON.stringify({
  scopedAuthorityChecksV1: { mode: "on" },
  exactTabCloseV2: { mode: "canary", schoolIds: ["school-a"], canaryPercent: 25 },
  kioskLaunchTicketV2: { mode: "observe" },
});

function rolloutEnv(
  rollouts: string | undefined,
  extra: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  if (rollouts !== undefined) env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = rollouts;
  return env;
}

describe("assertClasspilotCapabilityRolloutsEnv", () => {
  it("accepts a valid rollout map", () => {
    assert.doesNotThrow(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv(VALID_MAP)));
  });

  it("accepts an unset, empty, or whitespace-only value (flags-only mode)", () => {
    assert.doesNotThrow(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv(undefined)));
    assert.doesNotThrow(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv("")));
    assert.doesNotThrow(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv("   \n\t ")));
  });

  it("refuses malformed JSON", () => {
    assert.throws(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv("{not-json")), FATAL);
  });

  it("refuses an unknown capability key", () => {
    const map = JSON.stringify({ notARealCapability: { mode: "on" } });
    assert.throws(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv(map)), FATAL);
  });

  it("refuses an unsupported mode", () => {
    const map = JSON.stringify({ scopedAuthorityChecksV1: { mode: "maybe" } });
    assert.throws(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv(map)), FATAL);
  });

  it("refuses a canaryPercent outside 0-100", () => {
    const map = JSON.stringify({ scopedAuthorityChecksV1: { mode: "canary", canaryPercent: 101 } });
    assert.throws(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv(map)), FATAL);
  });

  it("refuses a non-array schoolIds", () => {
    const map = JSON.stringify({ scopedAuthorityChecksV1: { mode: "on", schoolIds: "x" } });
    assert.throws(() => assertClasspilotCapabilityRolloutsEnv(rolloutEnv(map)), FATAL);
  });

  it("warns, without throwing, when a valid map omits an enabled capability", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const map = JSON.stringify({ scopedAuthorityChecksV1: { mode: "on" } });

    assert.doesNotThrow(() =>
      assertClasspilotCapabilityRolloutsEnv(
        rolloutEnv(map, {
          CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
          CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2: "true",
        })
      )
    );

    assert.equal(warn.mock.callCount(), 1);
    const [firstCall] = warn.mock.calls;
    assert.ok(firstCall, "console.warn must have been called");
    const message = String(firstCall.arguments[0]);
    assert.match(message, /CLASSPILOT_CAPABILITY_ROLLOUTS_JSON omits enabled capabilities/);
    assert.match(message, /exactTabCloseV2/);
    assert.doesNotMatch(message, /scopedAuthorityChecksV1/);
  });

  it("stays quiet when every enabled capability has a map entry", (t) => {
    const warn = t.mock.method(console, "warn", () => {});

    assertClasspilotCapabilityRolloutsEnv(
      rolloutEnv(VALID_MAP, {
        CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
        CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2: "1",
      })
    );

    assert.equal(warn.mock.callCount(), 0);
  });

  it("does not warn about enabled flags when no map is configured", (t) => {
    const warn = t.mock.method(console, "warn", () => {});

    assertClasspilotCapabilityRolloutsEnv(
      rolloutEnv(undefined, { CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2: "true" })
    );

    assert.equal(warn.mock.callCount(), 0);
  });
});

describe("API boot wiring", () => {
  const indexSource = readFileSync(
    resolve(import.meta.dirname, "..", "src", "index.ts"),
    "utf8"
  );

  it("imports the assertion from the protocol module", () => {
    assert.match(
      indexSource,
      /import \{ assertClasspilotCapabilityRolloutsEnv \} from "\.\/services\/classpilotProtocol\.js";/
    );
  });

  it("calls the assertion from validateEnv after the MailPilot verify-token block", () => {
    const start = indexSource.indexOf("function validateEnv(): void {");
    const end = indexSource.indexOf("\nvalidateEnv();", start);
    assert.ok(start >= 0, "validateEnv must be declared in src/index.ts");
    assert.ok(end > start, "validateEnv must be invoked at module load");
    const validateEnv = indexSource.slice(start, end);

    const mailpilot = validateEnv.lastIndexOf("MAILPILOT_PUBSUB_VERIFY_TOKEN");
    const assertion = validateEnv.indexOf("assertClasspilotCapabilityRolloutsEnv();");
    assert.ok(mailpilot >= 0, "MailPilot verify-token block must remain in validateEnv");
    assert.ok(assertion >= 0, "validateEnv must call assertClasspilotCapabilityRolloutsEnv()");
    assert.ok(assertion > mailpilot, "rollout assertion must follow the MailPilot block");

    // Not gated on NODE_ENV: a set-but-invalid map has no legitimate use in any
    // environment. The call sits at function top level (two-space indent), and
    // nothing between the MailPilot block's closing brace and the call re-guards it.
    assert.match(validateEnv, /\n {2}assertClasspilotCapabilityRolloutsEnv\(\);/);
    const afterMailpilot = validateEnv.slice(mailpilot, assertion);
    assert.doesNotMatch(afterMailpilot.slice(afterMailpilot.indexOf("}")), /isProduction/);
  });
});
