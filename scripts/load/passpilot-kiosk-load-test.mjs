#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const KIOSK_LOAD_PROFILE = Object.freeze({
  schemaVersion: 1,
  clients: 100,
  classesPerSchool: 30,
  studentsPerSchool: 500,
  healthyIntervalMs: 5_000,
  failureBackoffMs: Object.freeze([5_000, 10_000, 20_000, 30_000]),
  requestTimeoutMs: 5_000,
  maximumP95Ms: 250,
  maximumErrorPercent: 0.5,
});

const repositoryRoot = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));

function usage() {
  process.stdout.write(`PassPilot kiosk load profile\n\n` +
    `Credential-free contract check:\n` +
    `  npm run load:kiosk -- --validate-fixtures\n\n` +
    `Private configuration preflight (no traffic):\n` +
    `  KIOSK_LOAD_MANIFEST=<absolute-private-path> npm run load:kiosk -- --validate-config\n\n` +
    `Traffic run:\n` +
    `  KIOSK_LOAD_BASE_URL=https://staging.school-pilot.net\n` +
    `  KIOSK_LOAD_MANIFEST=<absolute-private-path>\n` +
    `  KIOSK_LOAD_DURATION_SECONDS=300\n` +
    `  KIOSK_LOAD_SUMMARY_PATH=<absolute-path-outside-repository>\n\n` +
    `The private manifest is { profile, clients }, where profile declares the reviewed\n` +
    `30-class/500-student school fixture and clients contains exactly 100 entries of\n` +
    `{ schoolId, classId, kioskToken }. Identifiers and credentials are never printed.\n`);
}

function privateAbsolutePath(variableName) {
  const value = String(process.env[variableName] || "").trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${variableName} must be an absolute path outside the repository`);
  }
  const resolved = path.resolve(value);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`${variableName} must be outside the repository`);
  }
  return resolved;
}

function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Kiosk load manifest must be an object");
  }
  const profile = raw.profile;
  const clients = raw.clients;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Kiosk load manifest profile is required");
  }
  for (const [name, expected] of Object.entries({
    schemaVersion: KIOSK_LOAD_PROFILE.schemaVersion,
    clients: KIOSK_LOAD_PROFILE.clients,
    classesPerSchool: KIOSK_LOAD_PROFILE.classesPerSchool,
    studentsPerSchool: KIOSK_LOAD_PROFILE.studentsPerSchool,
  })) {
    if (Number(profile[name]) !== expected) {
      throw new Error(`Kiosk load profile ${name} must equal ${expected}`);
    }
  }
  if (!Array.isArray(clients) || clients.length !== KIOSK_LOAD_PROFILE.clients) {
    throw new Error(`Kiosk load manifest must contain exactly ${KIOSK_LOAD_PROFILE.clients} clients`);
  }
  const normalized = clients.map((client, index) => {
    if (!client || typeof client !== "object" || Array.isArray(client)) {
      throw new Error(`Kiosk load client ${index + 1} is invalid`);
    }
    const schoolId = String(client.schoolId || "").trim();
    const classId = String(client.classId || "").trim();
    const kioskToken = String(client.kioskToken || "").trim();
    if (!schoolId || schoolId.length > 128 || !classId || classId.length > 128) {
      throw new Error(`Kiosk load client ${index + 1} has an invalid binding`);
    }
    if (!kioskToken || kioskToken.length > 8_192) {
      throw new Error(`Kiosk load client ${index + 1} has an invalid credential`);
    }
    return Object.freeze({ schoolId, classId, kioskToken });
  });
  return Object.freeze({
    profile: Object.freeze({
      schemaVersion: Number(profile.schemaVersion),
      clients: Number(profile.clients),
      classesPerSchool: Number(profile.classesPerSchool),
      studentsPerSchool: Number(profile.studentsPerSchool),
    }),
    clients: Object.freeze(normalized),
  });
}

function syntheticManifest() {
  return {
    profile: {
      schemaVersion: 1,
      clients: 100,
      classesPerSchool: 30,
      studentsPerSchool: 500,
    },
    clients: Array.from({ length: 100 }, (_, index) => ({
      schoolId: "synthetic-school",
      classId: `synthetic-class-${index % 30}`,
      kioskToken: "private-synthetic-token",
    })),
  };
}

function readPrivateManifest() {
  const manifestPath = privateAbsolutePath("KIOSK_LOAD_MANIFEST");
  return validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
}

function percentile(values, percent) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percent / 100) - 1)];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestSnapshot(baseUrl, client, etag) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KIOSK_LOAD_PROFILE.requestTimeoutMs);
  timeout.unref?.();
  const startedAt = performance.now();
  try {
    const url = new URL("/api/passpilot/kiosk/snapshot", baseUrl);
    url.searchParams.set("classId", client.classId);
    const response = await fetch(url, {
      headers: {
        "X-School-Id": client.schoolId,
        "X-Kiosk-Token": client.kioskToken,
        ...(etag ? { "If-None-Match": etag } : {}),
      },
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (response.status === 304) {
      return { ok: true, latencyMs, etag, studentIds: [] };
    }
    const bodyText = await response.text();
    if (!response.ok) return { ok: false, latencyMs, status: response.status };
    if (Buffer.byteLength(bodyText, "utf8") > 5 * 1024 * 1024) {
      return { ok: false, latencyMs, status: "oversized" };
    }
    const body = JSON.parse(bodyText);
    if (!body || !Array.isArray(body.roster) || !body.revisions?.snapshot) {
      return { ok: false, latencyMs, status: "invalid_contract" };
    }
    return {
      ok: true,
      latencyMs,
      etag: response.headers.get("etag") || undefined,
      studentIds: body.roster
        .map((student) => String(student?.id || "").trim())
        .filter(Boolean),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      status: error?.name === "AbortError" ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runTraffic(manifest) {
  const baseUrl = String(process.env.KIOSK_LOAD_BASE_URL || "").trim();
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new Error("KIOSK_LOAD_BASE_URL must be an HTTPS origin");
  }
  const durationSeconds = Number(process.env.KIOSK_LOAD_DURATION_SECONDS || 300);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 3_600) {
    throw new Error("KIOSK_LOAD_DURATION_SECONDS must be an integer from 60 through 3600");
  }

  const deadline = Date.now() + durationSeconds * 1_000;
  const stats = {
    attempts: 0,
    successes: 0,
    failures: 0,
    notModified: 0,
    overlaps: 0,
    latencies: [],
    observedStudentsBySchool: new Map(),
  };

  await Promise.all(manifest.clients.map(async (client, index) => {
    await delay(Math.floor(index / manifest.clients.length * KIOSK_LOAD_PROFILE.healthyIntervalMs));
    let etag;
    let consecutiveFailures = 0;
    let inFlight = false;
    while (Date.now() < deadline) {
      if (inFlight) stats.overlaps += 1;
      inFlight = true;
      const result = await requestSnapshot(baseUrl, client, etag);
      inFlight = false;
      stats.attempts += 1;
      stats.latencies.push(result.latencyMs);
      if (result.ok) {
        stats.successes += 1;
        consecutiveFailures = 0;
        if (result.studentIds.length === 0 && etag) stats.notModified += 1;
        etag = result.etag || etag;
        let students = stats.observedStudentsBySchool.get(client.schoolId);
        if (!students) {
          students = new Set();
          stats.observedStudentsBySchool.set(client.schoolId, students);
        }
        for (const studentId of result.studentIds) students.add(studentId);
      } else {
        stats.failures += 1;
        consecutiveFailures += 1;
      }
      const baseDelay = result.ok
        ? KIOSK_LOAD_PROFILE.healthyIntervalMs
        : KIOSK_LOAD_PROFILE.failureBackoffMs[
            Math.min(consecutiveFailures - 1, KIOSK_LOAD_PROFILE.failureBackoffMs.length - 1)
          ];
      const jitter = result.ok ? 0 : Math.floor(Math.random() * Math.min(1_000, baseDelay / 5));
      if (Date.now() + baseDelay + jitter >= deadline) break;
      await delay(baseDelay + jitter);
    }
  }));

  const errorPercent = stats.attempts === 0 ? 100 : stats.failures / stats.attempts * 100;
  const observedStudentCounts = [...stats.observedStudentsBySchool.values()].map((students) => students.size);
  const summary = {
    schemaVersion: 1,
    profile: KIOSK_LOAD_PROFILE,
    durationSeconds,
    clients: manifest.clients.length,
    schoolCount: stats.observedStudentsBySchool.size,
    attempts: stats.attempts,
    successes: stats.successes,
    failures: stats.failures,
    notModified: stats.notModified,
    overlapCount: stats.overlaps,
    latencyMs: {
      p50: percentile(stats.latencies, 50),
      p95: percentile(stats.latencies, 95),
      p99: percentile(stats.latencies, 99),
      max: stats.latencies.length ? Math.max(...stats.latencies) : 0,
    },
    errorPercent: Number(errorPercent.toFixed(3)),
    observedStudents: {
      minimumPerSchool: observedStudentCounts.length ? Math.min(...observedStudentCounts) : 0,
      expectedPerSchool: KIOSK_LOAD_PROFILE.studentsPerSchool,
    },
  };
  summary.passed = summary.attempts > 0
    && summary.overlapCount === 0
    && summary.latencyMs.p95 <= KIOSK_LOAD_PROFILE.maximumP95Ms
    && summary.errorPercent <= KIOSK_LOAD_PROFILE.maximumErrorPercent
    && summary.observedStudents.minimumPerSchool >= KIOSK_LOAD_PROFILE.studentsPerSchool;

  const summaryPath = process.env.KIOSK_LOAD_SUMMARY_PATH
    ? privateAbsolutePath("KIOSK_LOAD_SUMMARY_PATH")
    : null;
  if (summaryPath) fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.passed) process.exitCode = 1;
}

if (process.argv.includes("--help")) {
  usage();
} else if (process.argv.includes("--validate-fixtures")) {
  const manifest = validateManifest(syntheticManifest());
  process.stdout.write(`${JSON.stringify({ ok: true, profile: manifest.profile, clientCount: manifest.clients.length })}\n`);
} else if (process.argv.includes("--validate-config")) {
  const manifest = readPrivateManifest();
  process.stdout.write(`${JSON.stringify({ ok: true, profile: manifest.profile, clientCount: manifest.clients.length })}\n`);
} else {
  await runTraffic(readPrivateManifest());
}
