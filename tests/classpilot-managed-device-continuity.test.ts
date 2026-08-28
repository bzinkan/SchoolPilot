import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY,
  CLASSPILOT_MANAGED_DEVICE_CONTINUITY_IP_REQUESTS_PER_MINUTE,
  CLASSPILOT_MANAGED_DEVICE_CONTINUITY_REQUESTS_PER_MINUTE,
  CLASSPILOT_MANAGED_DEVICE_PREFLIGHT_TTL_SECONDS,
  CLASSPILOT_MANAGED_DEVICE_PROOF_TTL_SECONDS,
  classpilotManagedDeviceAuthorizationPresented,
  classpilotManagedDeviceIssuanceRequestSchema,
  classpilotManagedDevicePreflightRequestSchema,
  classpilotManagedDevicePreflightTokenFromAuthorization,
  classpilotManagedDeviceProofFromAuthorization,
  issueClasspilotManagedDeviceContinuityProof,
  issueClasspilotManagedDevicePreflight,
  schoolScopedManagedClasspilotDeviceId,
  verifyClasspilotManagedDeviceContinuityProof,
  verifyClasspilotManagedDevicePreflight,
} from "../src/services/classpilotManagedDeviceContinuity.js";
import { schoolScopedManagedKioskDeviceId } from "../src/services/classpilotKioskLaunchTicket.js";
import { hashStudentSessionRecoveryToken } from "../src/services/classpilotStudentSessionAuthority.js";
import { negotiateClasspilotProtocol } from "../src/services/classpilotProtocol.js";

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);
const SCHOOL_A = "11111111-1111-4111-8111-111111111111";
const SCHOOL_B = "22222222-2222-4222-8222-222222222222";
const RAW_DIRECTORY_ID = "managed-directory-device-123456";
const RECOVERY_TOKEN = "A".repeat(43);
const AUDIENCE_A = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://api-a.school-pilot.test/",
};
const AUDIENCE_B = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://api-b.school-pilot.test",
};

function tamperLastCharacter(value: string): string {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

describe("ClassPilot managed-device continuity proofs", () => {
  it("keeps the preflight identifier-free and available without a new runtime flag", () => {
    assert.ok(
      CLASSPILOT_MANAGED_DEVICE_CONTINUITY_REQUESTS_PER_MINUTE >= 800 * 3,
      "one shared minute bucket must admit preflight, issuance, and one retry for 800 devices"
    );
    assert.ok(
      CLASSPILOT_MANAGED_DEVICE_CONTINUITY_IP_REQUESTS_PER_MINUTE >= 800 * 3,
      "the independent IP ceiling must remain safe for an 800-device school NAT"
    );
    const accepted = classpilotManagedDevicePreflightRequestSchema.safeParse({
      clientProtocolVersion: 3,
      capabilities: [
        "scopedAuthorityChecksV1",
        "kioskLaunchTicketV2",
        CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY,
      ],
    });
    assert.equal(accepted.success, true);
    const liveStyleProtocol = negotiateClasspilotProtocol({
      clientProtocolVersion: 3,
      advertisedCapabilities: [
        "scopedAuthorityChecksV1",
        "kioskLaunchTicketV2",
      ],
      scope: { schoolId: SCHOOL_A },
      env: {
        CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
        CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
        CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V2: "true",
        CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify({
          scopedAuthorityChecksV1: { mode: "on" },
          kioskLaunchTicketV2: { mode: "on" },
        }),
      },
    });
    assert.deepEqual(liveStyleProtocol.acceptedCapabilities, [
      "scopedAuthorityChecksV1",
      "kioskLaunchTicketV2",
    ]);

    for (const rejected of [
      {
        clientProtocolVersion: 3,
        capabilities: [
          "scopedAuthorityChecksV1",
          "kioskLaunchTicketV2",
          CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY,
        ],
        directoryDeviceId: RAW_DIRECTORY_ID,
      },
      {
        clientProtocolVersion: 3,
        capabilities: [CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY],
      },
      {
        clientProtocolVersion: 3,
        capabilities: ["scopedAuthorityChecksV1", "kioskLaunchTicketV2"],
      },
      {
        clientProtocolVersion: 2,
        capabilities: [
          "scopedAuthorityChecksV1",
          "kioskLaunchTicketV2",
          CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY,
        ],
      },
    ]) {
      assert.equal(
        classpilotManagedDevicePreflightRequestSchema.safeParse(rejected).success,
        false
      );
    }
  });

  it("caps rotating invalid enrollment keys through an independent IP bucket", () => {
    const routeSource = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8"
    );
    assert.match(
      routeSource,
      /const classpilotManagedDeviceContinuityIpLimiter = rateLimit\(\{[\s\S]*?keyGenerator: extensionIp,[\s\S]*?managed-device-continuity-ip:/,
      "the outer bucket must depend only on normalized request IP, never enrollment-key input"
    );
    for (const route of [
      "/extension/device-continuity/preflight",
      "/extension/device-continuity",
    ]) {
      const routeStart = routeSource.indexOf(`\"${route}\"`);
      assert.notEqual(routeStart, -1);
      const registration = routeSource.slice(routeStart, routeStart + 400);
      const ipLimiterIndex = registration.indexOf(
        "classpilotManagedDeviceContinuityIpLimiter"
      );
      const keyLimiterIndex = registration.indexOf(
        "classpilotManagedDeviceContinuityLimiter"
      );
      assert.ok(
        ipLimiterIndex >= 0
          && keyLimiterIndex >= 0
          && ipLimiterIndex < keyLimiterIndex,
        `${route} must apply the IP ceiling before the rotatable key/school bucket`
      );
    }
  });

  it("validates strict managed directory identifiers", () => {
    assert.equal(
      classpilotManagedDeviceIssuanceRequestSchema.safeParse({
        directoryDeviceId: RAW_DIRECTORY_ID,
        recoveryToken: RECOVERY_TOKEN,
      }).success,
      true
    );
    for (const directoryDeviceId of ["", "has whitespace", "slash/value", "x".repeat(513)]) {
      assert.equal(
        classpilotManagedDeviceIssuanceRequestSchema.safeParse({ directoryDeviceId }).success,
        false
      );
    }
    assert.equal(
      classpilotManagedDeviceIssuanceRequestSchema.safeParse({
        directoryDeviceId: RAW_DIRECTORY_ID,
        schoolId: SCHOOL_A,
      }).success,
      false,
      "school authority is forbidden in the raw-identifier body"
    );
    assert.equal(
      classpilotManagedDeviceIssuanceRequestSchema.safeParse({
        directoryDeviceId: RAW_DIRECTORY_ID,
        recoveryToken: "not-valid",
      }).success,
      false
    );
  });

  it("signs a bounded school-specific preflight", () => {
    const issued = issueClasspilotManagedDevicePreflight({
      schoolId: SCHOOL_A,
      now: NOW,
      env: AUDIENCE_A,
    });
    const sameSecond = issueClasspilotManagedDevicePreflight({
      schoolId: SCHOOL_A,
      now: NOW,
      env: AUDIENCE_A,
    });
    assert.notEqual(issued.preflightToken, sameSecond.preflightToken);
    assert.equal(issued.expiresInSeconds, CLASSPILOT_MANAGED_DEVICE_PREFLIGHT_TTL_SECONDS);
    assert.equal(
      verifyClasspilotManagedDevicePreflight({
        token: issued.preflightToken,
        schoolId: SCHOOL_A,
        now: NOW,
        env: AUDIENCE_A,
      }),
      true
    );
    assert.equal(
      verifyClasspilotManagedDevicePreflight({
        token: issued.preflightToken,
        schoolId: SCHOOL_B,
        now: NOW,
        env: AUDIENCE_A,
      }),
      false
    );
    assert.equal(
      verifyClasspilotManagedDevicePreflight({
        token: issued.preflightToken,
        schoolId: SCHOOL_A,
        now: NOW,
        env: AUDIENCE_B,
      }),
      false,
      "preflight authority cannot cross configured deployment audiences"
    );
    assert.equal(
      verifyClasspilotManagedDevicePreflight({
        token: issued.preflightToken,
        schoolId: SCHOOL_A,
        now: NOW + CLASSPILOT_MANAGED_DEVICE_PREFLIGHT_TTL_SECONDS * 1_000,
        env: AUDIENCE_A,
      }),
      false,
      "the proof is invalid at the exact expiry boundary"
    );
    assert.equal(
      verifyClasspilotManagedDevicePreflight({
        token: tamperLastCharacter(issued.preflightToken),
        schoolId: SCHOOL_A,
        now: NOW,
        env: AUDIENCE_A,
      }),
      false
    );
  });

  it("reduces the raw directory id before signing a reusable continuity proof", () => {
    const issued = issueClasspilotManagedDeviceContinuityProof({
      schoolId: SCHOOL_A,
      directoryDeviceId: RAW_DIRECTORY_ID,
      recoveryToken: RECOVERY_TOKEN,
      now: NOW,
      env: AUDIENCE_A,
    });
    const sameSecond = issueClasspilotManagedDeviceContinuityProof({
      schoolId: SCHOOL_A,
      directoryDeviceId: RAW_DIRECTORY_ID,
      recoveryToken: RECOVERY_TOKEN,
      now: NOW,
      env: AUDIENCE_A,
    });
    assert.notEqual(issued.continuityProof, sameSecond.continuityProof);
    assert.equal(issued.expiresInSeconds, CLASSPILOT_MANAGED_DEVICE_PROOF_TTL_SECONDS);
    assert.equal(issued.continuityProof.includes(RAW_DIRECTORY_ID), false);
    assert.equal(issued.continuityProof.includes(RECOVERY_TOKEN), false);

    const first = verifyClasspilotManagedDeviceContinuityProof({
      token: issued.continuityProof,
      schoolId: SCHOOL_A,
      now: NOW,
      env: AUDIENCE_A,
    });
    const second = verifyClasspilotManagedDeviceContinuityProof({
      token: issued.continuityProof,
      schoolId: SCHOOL_A,
      now: NOW + 30_000,
      env: AUDIENCE_A,
    });
    assert.ok(first);
    assert.ok(second, "the same short-lived proof supports roster then login");
    assert.equal(first.deviceId, schoolScopedManagedClasspilotDeviceId(SCHOOL_A, RAW_DIRECTORY_ID));
    assert.equal(first.recoveryTokenHash, hashStudentSessionRecoveryToken(RECOVERY_TOKEN));
    assert.match(
      first.deviceId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    assert.notEqual(
      first.deviceId,
      schoolScopedManagedClasspilotDeviceId(SCHOOL_B, RAW_DIRECTORY_ID),
      "the same enterprise identifier cannot correlate across schools"
    );
    assert.notEqual(
      first.deviceId,
      schoolScopedManagedKioskDeviceId(SCHOOL_A, RAW_DIRECTORY_ID),
      "ClassPilot and PassPilot projections use separate HMAC domains"
    );
    assert.equal(
      verifyClasspilotManagedDeviceContinuityProof({
        token: issued.continuityProof,
        schoolId: SCHOOL_B,
        now: NOW,
        env: AUDIENCE_A,
      }),
      null
    );
    assert.equal(
      verifyClasspilotManagedDeviceContinuityProof({
        token: issued.continuityProof,
        schoolId: SCHOOL_A,
        now: NOW,
        env: AUDIENCE_B,
      }),
      null,
      "device authority cannot cross configured deployment audiences"
    );
    assert.equal(
      verifyClasspilotManagedDeviceContinuityProof({
        token: issued.continuityProof,
        schoolId: SCHOOL_A,
        now: NOW + CLASSPILOT_MANAGED_DEVICE_PROOF_TTL_SECONDS * 1_000,
        env: AUDIENCE_A,
      }),
      null
    );
    assert.equal(
      verifyClasspilotManagedDeviceContinuityProof({
        token: "cpmd1.not-a-valid-proof.signature",
        schoolId: SCHOOL_A,
        now: NOW,
        env: AUDIENCE_A,
      }),
      null
    );
  });

  it("parses only the exact proof authorization schemes", () => {
    const preflight = issueClasspilotManagedDevicePreflight({ schoolId: SCHOOL_A, now: NOW });
    const proof = issueClasspilotManagedDeviceContinuityProof({
      schoolId: SCHOOL_A,
      directoryDeviceId: RAW_DIRECTORY_ID,
      now: NOW,
    });
    assert.equal(
      classpilotManagedDevicePreflightTokenFromAuthorization(
        `ClassPilot-Preflight ${preflight.preflightToken}`
      ),
      preflight.preflightToken
    );
    assert.equal(
      classpilotManagedDeviceProofFromAuthorization(
        `ClassPilot-Device ${proof.continuityProof}`
      ),
      proof.continuityProof
    );
    assert.equal(
      classpilotManagedDeviceProofFromAuthorization(
        `Bearer ${proof.continuityProof}`
      ),
      null
    );
    assert.equal(
      classpilotManagedDeviceAuthorizationPresented("ClassPilot-Device malformed"),
      true
    );
  });

  it("fails closed without a stable production audience", () => {
    assert.throws(
      () => issueClasspilotManagedDevicePreflight({
        schoolId: SCHOOL_A,
        env: { NODE_ENV: "production" },
      }),
      (error: unknown) =>
        error instanceof Error
        && "status" in error
        && error.status === 503
        && "code" in error
        && error.code === "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAVAILABLE"
    );
    assert.throws(
      () => issueClasspilotManagedDeviceContinuityProof({
        schoolId: SCHOOL_A,
        directoryDeviceId: RAW_DIRECTORY_ID,
        env: {
          NODE_ENV: "production",
          PUBLIC_BASE_URL: "https://api.school-pilot.test/?untrusted=1",
        },
      }),
      (error: unknown) =>
        error instanceof Error
        && "status" in error
        && error.status === 503
        && "code" in error
        && error.code === "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAVAILABLE"
    );
  });
});
