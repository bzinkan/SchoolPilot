import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  classpilotObservationStatus,
  classpilotObservationSubjectKeysForTests,
  classpilotSupervisionObservationStatus,
  releaseClasspilotSupervisionObservationLeaseWithState,
  renewClasspilotObservationLease,
  renewClasspilotSupervisionObservationLease,
  resetClasspilotObservationLeasesForTests,
} from "../src/services/classpilotObservationLease.js";

// The derivation is keyed by an HMAC secret, so pinning the output only means
// something against a fixed secret. keySecret() reads the environment lazily on
// every digest, so setting it here (after the import, before any test body
// runs) is enough to pin every derivation in this file.
process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET = "pinned-observation-secret";
// Local-fallback lane: no Redis, no database.
delete process.env.REDIS_URL;

const PINNED = {
  schoolId: "school-pin",
  subjectId: "subject-pin",
  viewerUserId: "viewer-user-pin",
  viewerInstanceId: "viewer-instance-pin",
} as const;

// Recompute the derivation independently rather than hard-coding its output.
// A literal digest is a high-entropy string that secret scanners flag, and it
// pins only the result; recomputing pins the algorithm, the secret, the parts,
// their order and the separator — all the things a refactor could move.
function expectedDigest(parts: string[]): string {
  return createHmac("sha256", process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET!)
    .update(parts.join(""))
    .digest("base64url");
}

test("the teaching-session lease key derivation is frozen byte-for-byte", () => {
  const derived = classpilotObservationSubjectKeysForTests({
    schoolId: PINNED.schoolId,
    subjectKind: "teaching_session",
    subjectId: PINNED.subjectId,
    viewerUserId: PINNED.viewerUserId,
    viewerInstanceId: PINNED.viewerInstanceId,
  });
  // Exactly what the pre-supervision implementation computed:
  //   `classpilot:observation:v1:${digest([schoolId, teachingSessionId])}`
  //   digest([schoolId, teachingSessionId, viewerUserId, viewerInstanceId])
  // A rolling deploy that changes either one orphans every in-flight lease —
  // the old process keeps renewing keys the new process never reads — so this
  // must fail loudly rather than degrade quietly. Note there is deliberately
  // NO domain tag on this branch: adding one would be such a change.
  const expectedIndexDigest = expectedDigest([PINNED.schoolId, PINNED.subjectId]);
  const expectedViewerKey = expectedDigest([
    PINNED.schoolId,
    PINNED.subjectId,
    PINNED.viewerUserId,
    PINNED.viewerInstanceId,
  ]);
  assert.equal(derived.indexKey, `classpilot:observation:v1:${expectedIndexDigest}`);
  assert.equal(derived.viewerKey, expectedViewerKey);
  assert.equal(
    derived.viewerDataKey,
    `classpilot:observation:v1:${expectedIndexDigest}:viewer:${expectedViewerKey}`
  );
});

test("a supervision context cannot collide with an identically named teaching session", () => {
  const shared = {
    schoolId: PINNED.schoolId,
    subjectId: PINNED.subjectId,
    viewerUserId: PINNED.viewerUserId,
    viewerInstanceId: PINNED.viewerInstanceId,
  };
  const teaching = classpilotObservationSubjectKeysForTests({
    ...shared,
    subjectKind: "teaching_session",
  });
  const supervision = classpilotObservationSubjectKeysForTests({
    ...shared,
    subjectKind: "supervision_context",
  });
  assert.notEqual(supervision.indexKey, teaching.indexKey);
  assert.notEqual(supervision.viewerKey, teaching.viewerKey);
  assert.match(supervision.indexKey, /^classpilot:observation:supervision:v1:/);
  // The prefixes alone would separate the namespaces, but the digest is domain
  // tagged too so neither key can be forged from the other's identifier.
  assert.notEqual(
    supervision.indexKey.replace("classpilot:observation:supervision:v1:", ""),
    teaching.indexKey.replace("classpilot:observation:v1:", "")
  );
  assert.equal(
    supervision.indexKey,
    "classpilot:observation:supervision:v1:BGi0xeRbF98vxCTPsb4rnS_iByAHE0gC1RjDZiesyWY"
  );
});

test("a missing supervision context reads as unobserved, never unavailable", async () => {
  resetClasspilotObservationLeasesForTests();
  for (const supervisionContextId of [null, undefined, ""]) {
    assert.deepEqual(await classpilotSupervisionObservationStatus({
      schoolId: "school",
      supervisionContextId,
      studentId: "student-a",
      now: 1_000,
    }), { status: "unobserved", expiresInSeconds: 0 });
  }
});

test("supervision leases observe their own namespace and never the class one", async () => {
  resetClasspilotObservationLeasesForTests();
  try {
    const lease = await renewClasspilotSupervisionObservationLease({
      schoolId: "school",
      supervisionContextId: "context",
      viewerUserId: "supervisor",
      viewerInstanceId: "viewer-a",
      scope: { kind: "students", studentIds: ["student-a"] },
      now: 1_000,
    });
    assert.equal(lease.created, true);
    assert.equal(lease.changed, true);
    assert.equal(lease.activated, true);

    assert.deepEqual(await classpilotSupervisionObservationStatus({
      schoolId: "school",
      supervisionContextId: "context",
      studentId: "student-a",
      now: 2_000,
    }), { status: "observed", expiresInSeconds: 89 });
    assert.deepEqual(await classpilotSupervisionObservationStatus({
      schoolId: "school",
      supervisionContextId: "context",
      studentId: "student-b",
      now: 2_000,
    }), { status: "unobserved", expiresInSeconds: 0 });

    // Same school, same identifier, same student: the teaching-session
    // namespace must not see the supervision lease at all.
    assert.deepEqual(await classpilotObservationStatus({
      schoolId: "school",
      teachingSessionId: "context",
      studentId: "student-a",
      now: 2_000,
    }), { status: "unobserved", expiresInSeconds: 0 });

    // ...and the reverse: a teaching-session lease is invisible to supervision.
    await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "other-context",
      viewerUserId: "teacher",
      viewerInstanceId: "viewer-b",
      scope: { kind: "class" },
      now: 2_000,
    });
    assert.deepEqual(await classpilotSupervisionObservationStatus({
      schoolId: "school",
      supervisionContextId: "other-context",
      studentId: "student-a",
      now: 2_100,
    }), { status: "unobserved", expiresInSeconds: 0 });

    assert.deepEqual(await releaseClasspilotSupervisionObservationLeaseWithState({
      schoolId: "school",
      supervisionContextId: "context",
      viewerUserId: "supervisor",
      viewerInstanceId: "viewer-a",
      now: 2_200,
    }), { released: true, deactivated: true });
    assert.equal((await classpilotSupervisionObservationStatus({
      schoolId: "school",
      supervisionContextId: "context",
      studentId: "student-a",
      now: 2_200,
    })).status, "unobserved");
  } finally {
    resetClasspilotObservationLeasesForTests();
  }
});
