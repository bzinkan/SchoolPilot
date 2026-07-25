#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const VERSION = "classpilot-tile-auth-plan-base-funnel-v1";
const COHORT_SIZE = 40;
const REQUIRED_SESSION_PAIRS = 80;
const MAX_COUNT = 1_000_000;
const COUNT_KEYS = [
  "syntheticDescribedGroups",
  "syntheticSchoolGroups",
  "primaryTeacherGroups",
  "licensedGroups",
  "activeRosterStudents",
  "canonicalMappedRosterStudents",
  "unsupervisedRosterStudents",
  "noCoTeacherGroups",
  "exactCohortGroups",
  "eligibleGroupSchools",
  "activeOfficeMemberships",
  "uniqueOfficeMembershipSchools",
  "activeOfficeStudents",
  "canonicalMappedOfficeStudents",
  "unrosteredOfficeStudents",
  "unsupervisedOfficeStudents",
  "officeCohortReadySchools",
  "alternateTeacherReadySchools",
  "eligibleSchools",
  "selectedSchools",
  "selectedGroups",
  "selectedCoTeachers",
  "selectedOfficeStaff",
  "selectedOfficeCohorts",
  "finalBases",
];
const ROOT_KEYS = [
  "cohortSize",
  "counts",
  "failureStage",
  "firstEmptyStage",
  "sessionPosture",
  "version",
];
const SESSION_KEYS = [
  "conflictingSessionPairs",
  "missingSessionPairs",
  "requiredSessionPairs",
  "reusedActiveSessionPairs",
];
const FAILURE_STAGES = new Set([
  "base_funnel",
  "base_shape",
  "session_posture",
]);
const FAILURE_EVENT_KEYS = [
  "failureCode",
  "funnelEvidence",
  "invalidTeachingSessionSchools",
  "labels",
  "status",
];
const INVALID =
  "classpilot_tile_authorization_plan_base_funnel_invalid";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function reject() {
  throw new Error(INVALID);
}

function firstEmptyStage(counts) {
  return COUNT_KEYS.find((key) => counts[key] === 0) ?? "none";
}

function validCountRelationships(counts) {
  return (
    counts.syntheticSchoolGroups <= counts.syntheticDescribedGroups &&
    counts.primaryTeacherGroups <= counts.syntheticSchoolGroups &&
    counts.licensedGroups <= counts.primaryTeacherGroups &&
    counts.canonicalMappedRosterStudents <= counts.activeRosterStudents &&
    counts.unsupervisedRosterStudents <=
      counts.canonicalMappedRosterStudents &&
    counts.noCoTeacherGroups <= counts.licensedGroups &&
    counts.exactCohortGroups <= counts.noCoTeacherGroups &&
    counts.eligibleGroupSchools <= counts.exactCohortGroups &&
    counts.exactCohortGroups * COHORT_SIZE <=
      counts.unsupervisedRosterStudents &&
    counts.uniqueOfficeMembershipSchools <= counts.eligibleGroupSchools &&
    counts.uniqueOfficeMembershipSchools <= counts.activeOfficeMemberships &&
    counts.canonicalMappedOfficeStudents <= counts.activeOfficeStudents &&
    counts.unrosteredOfficeStudents <=
      counts.canonicalMappedOfficeStudents &&
    counts.unsupervisedOfficeStudents <= counts.unrosteredOfficeStudents &&
    counts.officeCohortReadySchools <= counts.eligibleGroupSchools &&
    counts.alternateTeacherReadySchools <= counts.eligibleGroupSchools &&
    counts.eligibleSchools <= counts.uniqueOfficeMembershipSchools &&
    counts.eligibleSchools <= counts.officeCohortReadySchools &&
    counts.eligibleSchools <= counts.alternateTeacherReadySchools &&
    counts.selectedSchools <= 1 &&
    counts.selectedSchools <= counts.eligibleSchools &&
    counts.selectedGroups <= 1 &&
    counts.selectedGroups <= counts.selectedSchools &&
    counts.selectedCoTeachers <= 1 &&
    counts.selectedCoTeachers <= counts.selectedGroups &&
    counts.selectedOfficeStaff <= 1 &&
    counts.selectedOfficeStaff <= counts.selectedSchools &&
    counts.selectedOfficeCohorts <= 1 &&
    counts.selectedOfficeCohorts <= counts.selectedSchools &&
    counts.finalBases <= 1 &&
    counts.finalBases <= counts.selectedGroups &&
    counts.finalBases <= counts.selectedCoTeachers &&
    counts.finalBases <= counts.selectedOfficeStaff &&
    counts.finalBases <= counts.selectedOfficeCohorts
  );
}

export function validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(
  value
) {
  if (
    !hasExactKeys(value, ROOT_KEYS) ||
    value.version !== VERSION ||
    !FAILURE_STAGES.has(value.failureStage) ||
    value.cohortSize !== COHORT_SIZE ||
    !hasExactKeys(value.counts, COUNT_KEYS)
  ) {
    reject();
  }

  const counts = Object.fromEntries(
    COUNT_KEYS.map((key) => [key, value.counts[key]])
  );
  if (
    COUNT_KEYS.some(
      (key) =>
        !Number.isInteger(counts[key]) ||
        counts[key] < 0 ||
        counts[key] > MAX_COUNT
    ) ||
    !validCountRelationships(counts)
  ) {
    reject();
  }

  const expectedFirstEmptyStage = firstEmptyStage(counts);
  if (
    ![...COUNT_KEYS, "none"].includes(value.firstEmptyStage) ||
    value.firstEmptyStage !== expectedFirstEmptyStage
  ) {
    reject();
  }

  let sessionPosture = null;
  if (value.sessionPosture !== null) {
    if (!hasExactKeys(value.sessionPosture, SESSION_KEYS)) reject();
    const requiredSessionPairs = value.sessionPosture.requiredSessionPairs;
    const reusedActiveSessionPairs =
      value.sessionPosture.reusedActiveSessionPairs;
    const missingSessionPairs = value.sessionPosture.missingSessionPairs;
    const conflictingSessionPairs =
      value.sessionPosture.conflictingSessionPairs;
    if (
      ![
        requiredSessionPairs,
        reusedActiveSessionPairs,
        missingSessionPairs,
        conflictingSessionPairs,
      ].every((entry) => Number.isInteger(entry) && entry >= 0) ||
      requiredSessionPairs !== REQUIRED_SESSION_PAIRS ||
      reusedActiveSessionPairs +
          missingSessionPairs +
          conflictingSessionPairs !==
        requiredSessionPairs
    ) {
      reject();
    }
    sessionPosture = {
      requiredSessionPairs,
      reusedActiveSessionPairs,
      missingSessionPairs,
      conflictingSessionPairs,
    };
  }

  if (
    (value.failureStage === "base_funnel" &&
      (counts.finalBases !== 0 ||
        expectedFirstEmptyStage === "none" ||
        sessionPosture !== null)) ||
    (value.failureStage === "base_shape" &&
      (counts.finalBases !== 1 ||
        expectedFirstEmptyStage !== "none" ||
        sessionPosture !== null)) ||
    (value.failureStage === "session_posture" &&
      (counts.finalBases !== 1 ||
        expectedFirstEmptyStage !== "none" ||
        sessionPosture === null ||
        sessionPosture.conflictingSessionPairs === 0))
  ) {
    reject();
  }

  return {
    version: VERSION,
    failureStage: value.failureStage,
    firstEmptyStage: expectedFirstEmptyStage,
    cohortSize: COHORT_SIZE,
    counts,
    sessionPosture,
  };
}

export function extractClasspilotTileAuthorizationPlanBaseFunnelEvidence(
  eventsDocument
) {
  const events = Array.isArray(eventsDocument?.events)
    ? eventsDocument.events
    : [];
  const matches = [];
  for (const event of events) {
    if (!isRecord(event) || typeof event.message !== "string") continue;
    let message;
    try {
      message = JSON.parse(event.message);
    } catch {
      continue;
    }
    if (
      hasExactKeys(message, FAILURE_EVENT_KEYS) &&
      message.status === "failed" &&
      message.failureCode === "representative_scenario_missing" &&
      Array.isArray(message.labels) &&
      message.labels.length === 0 &&
      message.invalidTeachingSessionSchools === 0
    ) {
      matches.push(message.funnelEvidence);
    }
  }
  if (matches.length !== 1) reject();
  return validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(matches[0]);
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const evidence =
      extractClasspilotTileAuthorizationPlanBaseFunnelEvidence(
        JSON.parse(await readStdin())
      );
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch {
    process.stderr.write(`${INVALID}\n`);
    process.exitCode = 1;
  }
}
