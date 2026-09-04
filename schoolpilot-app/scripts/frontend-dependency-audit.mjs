#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const AUDIT_SCHEMA_VERSION = "frontend-dependency-audit-v2";
const REACHABILITY_SCHEMA_VERSION = "frontend-router-reachability-v2";
const ROUTER_PACKAGE = "react-router";
const ROUTER_DOM_PACKAGE = "react-router-dom";
const ROUTER_VERSION = "7.18.2";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const ADVISORY_ID_PATTERN = /(?:^|\/)(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})(?:$|[/?#])/i;
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const SEVERITY_RANK = new Map(SEVERITIES.map((severity, index) => [
  severity,
  index,
]));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeString(value, maximumLength = 512) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function requireExactKeys(value, expectedKeys, failureCode) {
  const actual = isRecord(value) ? Object.keys(value).sort() : [];
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(failureCode);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJsonDocument(raw, failureCode) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(failureCode);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(failureCode);
  }
}

function normalizeFixAvailable(value) {
  if (value === false) {
    return {
      available: false,
      name: null,
      version: null,
      isSemVerMajor: null,
    };
  }
  if (value === true) {
    return {
      available: true,
      name: null,
      version: null,
      isSemVerMajor: null,
    };
  }
  if (!isRecord(value) ||
      !isSafeString(value.name, 214) ||
      !isSafeString(value.version, 128) ||
      typeof value.isSemVerMajor !== "boolean") {
    throw new Error("npm_audit_fix_available_invalid");
  }
  return {
    available: true,
    name: value.name,
    version: value.version,
    isSemVerMajor: value.isSemVerMajor,
  };
}

function compareFixes(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function extractAdvisoryId(url, source) {
  if (isSafeString(url, 2048)) {
    const match = url.match(ADVISORY_ID_PATTERN);
    if (match) return `GHSA-${match[1].slice(5).toLowerCase()}`;
  }
  if ((typeof source === "number" && Number.isSafeInteger(source) && source > 0) ||
      (typeof source === "string" && /^[1-9]\d*$/.test(source))) {
    return `NPM-${source}`;
  }
  throw new Error("npm_audit_advisory_id_invalid");
}

function normalizeAdvisory(via, packageName, fixAvailable) {
  if (!isRecord(via) ||
      !isSafeString(via.name, 214) ||
      !isSafeString(via.dependency, 214) ||
      via.name !== via.dependency ||
      via.dependency !== packageName ||
      !isSafeString(via.title, 1024) ||
      !isSafeString(via.url, 2048) ||
      !SEVERITIES.includes(via.severity) ||
      !isSafeString(via.range, 512)) {
    throw new Error("npm_audit_advisory_invalid");
  }
  const advisoryId = extractAdvisoryId(via.url, via.source);
  return {
    advisoryId,
    severity: via.severity,
    title: via.title,
    url: via.url,
    vulnerableRanges: [via.range],
    advisoryPackages: [via.dependency],
    affectedPackages: [...new Set([via.dependency, packageName])].sort(),
    fixAvailability: [fixAvailable],
  };
}

function mergeAdvisory(target, candidate) {
  for (const key of ["severity", "title", "url"]) {
    if (target[key] !== candidate[key]) {
      throw new Error("npm_audit_advisory_conflict");
    }
  }
  target.vulnerableRanges = [
    ...new Set([...target.vulnerableRanges, ...candidate.vulnerableRanges]),
  ].sort();
  target.advisoryPackages = [
    ...new Set([...target.advisoryPackages, ...candidate.advisoryPackages]),
  ].sort();
  target.affectedPackages = [
    ...new Set([...target.affectedPackages, ...candidate.affectedPackages]),
  ].sort();
  const fixes = new Map(
    [...target.fixAvailability, ...candidate.fixAvailability]
      .map((fix) => [JSON.stringify(fix), fix])
  );
  target.fixAvailability = [...fixes.values()].sort(compareFixes);
}

function cloneAdvisory(advisory) {
  return {
    advisoryId: advisory.advisoryId,
    severity: advisory.severity,
    title: advisory.title,
    url: advisory.url,
    vulnerableRanges: [...advisory.vulnerableRanges],
    advisoryPackages: [...advisory.advisoryPackages],
    affectedPackages: [...advisory.affectedPackages],
    fixAvailability: advisory.fixAvailability.map((fix) => ({ ...fix })),
  };
}

function addRecordPathToAdvisory(advisory, recordName, fixAvailable) {
  const propagated = cloneAdvisory(advisory);
  propagated.affectedPackages = [
    ...new Set([...propagated.affectedPackages, recordName]),
  ].sort();
  const fixes = new Map(
    [...propagated.fixAvailability, fixAvailable]
      .map((fix) => [JSON.stringify(fix), fix])
  );
  propagated.fixAvailability = [...fixes.values()].sort(compareFixes);
  return propagated;
}

function mergeAdvisoryIntoMap(advisoryMap, advisory) {
  const existing = advisoryMap.get(advisory.advisoryId);
  if (existing) mergeAdvisory(existing, advisory);
  else advisoryMap.set(advisory.advisoryId, cloneAdvisory(advisory));
}

function normalizeAuditMetadata(metadata, vulnerabilityRecords) {
  if (!isRecord(metadata) ||
      !isRecord(metadata.vulnerabilities) ||
      !isRecord(metadata.dependencies)) {
    throw new Error("npm_audit_metadata_invalid");
  }
  const counts = {};
  for (const severity of [...SEVERITIES, "total"]) {
    const count = metadata.vulnerabilities[severity];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("npm_audit_metadata_invalid");
    }
    counts[severity] = count;
  }
  if (counts.total !== SEVERITIES.reduce(
    (sum, severity) => sum + counts[severity],
    0
  ) || counts.total !== vulnerabilityRecords.length) {
    throw new Error("npm_audit_metadata_counts_invalid");
  }
  for (const severity of SEVERITIES) {
    if (counts[severity] !== vulnerabilityRecords.filter(
      (record) => record.severity === severity
    ).length) {
      throw new Error("npm_audit_metadata_counts_invalid");
    }
  }

  const dependencies = {};
  for (const key of ["prod", "dev", "optional", "peer", "peerOptional", "total"]) {
    const count = metadata.dependencies[key];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("npm_audit_dependency_counts_invalid");
    }
    dependencies[key] = count;
  }
  return { vulnerabilityRecords: counts, dependencies };
}

export function parseNpmAuditV2Result({
  scope,
  exitCode,
  stdout,
  invocationError = null,
}) {
  if (scope !== "production" && scope !== "full") {
    throw new Error("npm_audit_scope_invalid");
  }
  if (invocationError !== null && invocationError !== undefined) {
    throw new Error("npm_audit_invocation_failed");
  }
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error("npm_audit_tool_exit_invalid");
  }

  const document = parseJsonDocument(stdout, "npm_audit_json_invalid");
  // Distinguish an upstream stall from a malformed report. npm exits 0 and
  // prints {"message":"network timeout at: ..."} when the advisory endpoint
  // does not answer in time; reporting that as a schema fault sends the
  // operator looking for a code or npm-version problem that does not exist.
  if (isRecord(document) &&
      typeof document.message === "string" &&
      /network timeout/i.test(document.message)) {
    throw new Error("npm_audit_network_timeout");
  }
  if (!isRecord(document) ||
      document.auditReportVersion !== 2 ||
      !isRecord(document.vulnerabilities)) {
    throw new Error("npm_audit_schema_invalid");
  }

  const recordDefinitions = new Map();
  for (const [recordKey, vulnerability] of Object.entries(document.vulnerabilities)) {
    if (!isSafeString(recordKey, 214) ||
        !isRecord(vulnerability) ||
        vulnerability.name !== recordKey ||
        !SEVERITIES.includes(vulnerability.severity) ||
        typeof vulnerability.isDirect !== "boolean" ||
        !Array.isArray(vulnerability.via) ||
        !Array.isArray(vulnerability.effects) ||
        !Array.isArray(vulnerability.nodes) ||
        vulnerability.nodes.length === 0 ||
        !isSafeString(vulnerability.range, 512)) {
      throw new Error("npm_audit_vulnerability_invalid");
    }
    for (const value of [...vulnerability.effects, ...vulnerability.nodes]) {
      if (!isSafeString(value, 1024)) {
        throw new Error("npm_audit_vulnerability_invalid");
      }
    }
    const fixAvailable = normalizeFixAvailable(vulnerability.fixAvailable);
    const directAdvisories = [];
    const viaReferences = [];
    for (const via of vulnerability.via) {
      if (typeof via === "string") {
        if (!isSafeString(via, 214)) {
          throw new Error("npm_audit_vulnerability_invalid");
        }
        viaReferences.push(via);
      } else {
        directAdvisories.push(
          normalizeAdvisory(via, vulnerability.name, fixAvailable)
        );
      }
    }
    recordDefinitions.set(recordKey, {
      name: vulnerability.name,
      severity: vulnerability.severity,
      direct: vulnerability.isDirect,
      effects: [...new Set(vulnerability.effects)].sort(),
      nodes: [...new Set(vulnerability.nodes)].sort(),
      fixAvailable,
      directAdvisories,
      viaReferences: [...new Set(viaReferences)].sort(),
    });
  }

  for (const definition of recordDefinitions.values()) {
    for (const reference of definition.viaReferences) {
      if (!recordDefinitions.has(reference)) {
        throw new Error("npm_audit_via_reference_missing");
      }
    }
  }

  const resolutionState = new Map();
  const resolvedByRecord = new Map();
  function resolveRecord(recordName) {
    const state = resolutionState.get(recordName);
    if (state === "visiting") {
      throw new Error("npm_audit_via_cycle");
    }
    if (state === "resolved") return resolvedByRecord.get(recordName);
    resolutionState.set(recordName, "visiting");
    const definition = recordDefinitions.get(recordName);
    const resolved = new Map();
    for (const advisory of definition.directAdvisories) {
      mergeAdvisoryIntoMap(resolved, advisory);
    }
    for (const reference of definition.viaReferences) {
      for (const advisory of resolveRecord(reference).values()) {
        mergeAdvisoryIntoMap(
          resolved,
          addRecordPathToAdvisory(
            advisory,
            definition.name,
            definition.fixAvailable
          )
        );
      }
    }
    if (resolved.size === 0) {
      throw new Error("npm_audit_advisories_missing");
    }
    const maximumResolvedSeverity = [...resolved.values()]
      .map((advisory) => advisory.severity)
      .sort(
        (left, right) =>
          SEVERITY_RANK.get(right) - SEVERITY_RANK.get(left)
      )[0];
    if (maximumResolvedSeverity !== definition.severity) {
      throw new Error("npm_audit_via_severity_conflict");
    }
    resolvedByRecord.set(recordName, resolved);
    resolutionState.set(recordName, "resolved");
    return resolved;
  }

  const advisoryMap = new Map();
  const vulnerabilityRecords = [];
  for (const definition of recordDefinitions.values()) {
    const resolved = resolveRecord(definition.name);
    for (const advisory of resolved.values()) {
      mergeAdvisoryIntoMap(advisoryMap, advisory);
    }
    vulnerabilityRecords.push({
      name: definition.name,
      severity: definition.severity,
      direct: definition.direct,
      nodes: definition.nodes,
      resolvedAdvisoryIds: [...resolved.keys()].sort(),
    });
  }

  const metadata = normalizeAuditMetadata(document.metadata, vulnerabilityRecords);
  if ((exitCode === 0) !== (metadata.vulnerabilityRecords.total === 0)) {
    throw new Error("npm_audit_exit_findings_mismatch");
  }
  if (metadata.vulnerabilityRecords.total > 0 && advisoryMap.size === 0) {
    throw new Error("npm_audit_advisories_missing");
  }

  const advisories = [...advisoryMap.values()]
    .sort((left, right) => left.advisoryId.localeCompare(right.advisoryId));
  const advisoryCounts = Object.fromEntries(
    SEVERITIES.map((severity) => [
      severity,
      advisories.filter((advisory) => advisory.severity === severity).length,
    ])
  );
  advisoryCounts.total = advisories.length;

  return {
    scope,
    toolExitCode: exitCode,
    vulnerabilityRecords: vulnerabilityRecords
      .sort((left, right) => left.name.localeCompare(right.name)),
    advisories,
    counts: {
      advisoryIds: advisoryCounts,
      vulnerabilityRecords: metadata.vulnerabilityRecords,
      dependencies: metadata.dependencies,
    },
  };
}

function validateMetadata(metadata) {
  requireExactKeys(
    metadata,
    ["commitSha", "nodeVersion", "npmVersion", "evaluatedAtUtc"],
    "frontend_audit_metadata_invalid"
  );
  if (!COMMIT_PATTERN.test(metadata.commitSha) ||
      !isSafeString(metadata.nodeVersion, 64) ||
      !isSafeString(metadata.npmVersion, 64) ||
      typeof metadata.evaluatedAtUtc !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
        metadata.evaluatedAtUtc
      ) ||
      !Number.isFinite(Date.parse(metadata.evaluatedAtUtc))) {
    throw new Error("frontend_audit_metadata_invalid");
  }
  return {
    commitSha: metadata.commitSha,
    nodeVersion: metadata.nodeVersion,
    npmVersion: metadata.npmVersion,
    evaluatedAtUtc: metadata.evaluatedAtUtc,
  };
}

function readLockedRouterVersions(packageLock) {
  if (!isRecord(packageLock) ||
      packageLock.lockfileVersion !== 3 ||
      !isRecord(packageLock.packages)) {
    throw new Error("package_lock_schema_invalid");
  }
  const router = packageLock.packages["node_modules/react-router"];
  const routerDom = packageLock.packages["node_modules/react-router-dom"];
  if (!isRecord(router) || !isRecord(routerDom) ||
      !isSafeString(router.version, 128) ||
      !isSafeString(routerDom.version, 128)) {
    throw new Error("router_lock_identity_missing");
  }
  return {
    router: {
      packageName: ROUTER_PACKAGE,
      version: router.version,
    },
    routerDom: {
      packageName: ROUTER_DOM_PACKAGE,
      version: routerDom.version,
    },
  };
}

function classifyAuditScopeAgainstLock(audit, packageLock) {
  if (!isRecord(packageLock) || !isRecord(packageLock.packages)) {
    throw new Error("package_lock_schema_invalid");
  }
  const records = audit.vulnerabilityRecords.map((record) => {
    const productionNodes = [];
    const developmentNodes = [];
    for (const node of record.nodes) {
      const lockEntry = packageLock.packages[node];
      if (!isRecord(lockEntry) ||
          (lockEntry.dev !== undefined && typeof lockEntry.dev !== "boolean")) {
        throw new Error("frontend_dependency_audit_lock_scope_invalid");
      }
      if (lockEntry.dev === true) developmentNodes.push(node);
      else productionNodes.push(node);
    }
    if (audit.scope === "production" &&
        (productionNodes.length === 0 || developmentNodes.length > 0)) {
      throw new Error("frontend_dependency_audit_scope_drift");
    }
    return {
      ...record,
      dependencyScope:
        productionNodes.length > 0 ? "production" : "development",
      productionNodes: productionNodes.sort(),
      developmentNodes: developmentNodes.sort(),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));

  const advisoryScopes = new Map();
  for (const record of records) {
    for (const advisoryId of record.resolvedAdvisoryIds) {
      const scopes = advisoryScopes.get(advisoryId) ?? new Set();
      scopes.add(record.dependencyScope);
      advisoryScopes.set(advisoryId, scopes);
    }
  }
  return { records, advisoryScopes };
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validateAuditScopeSnapshots(production, full) {
  const productionByName = new Map(
    production.records.map((record) => [record.name, record])
  );
  const fullByName = new Map(full.records.map((record) => [record.name, record]));
  for (const productionRecord of production.records) {
    const fullRecord = fullByName.get(productionRecord.name);
    if (!fullRecord ||
        fullRecord.dependencyScope !== "production" ||
        fullRecord.severity !== productionRecord.severity ||
        fullRecord.direct !== productionRecord.direct ||
        !sameStringSet(
          fullRecord.resolvedAdvisoryIds,
          productionRecord.resolvedAdvisoryIds
        ) ||
        !sameStringSet(
          fullRecord.productionNodes,
          productionRecord.productionNodes
        )) {
      throw new Error("frontend_dependency_audit_scope_drift");
    }
  }
  for (const fullRecord of full.records) {
    if (fullRecord.dependencyScope === "production" &&
        !productionByName.has(fullRecord.name)) {
      throw new Error("frontend_dependency_audit_scope_drift");
    }
  }
  for (const [advisoryId, scopes] of full.advisoryScopes) {
    const productionScopes = production.advisoryScopes.get(advisoryId);
    if (scopes.has("production") !== Boolean(productionScopes?.has("production"))) {
      throw new Error("frontend_dependency_audit_scope_drift");
    }
  }
}

function validateOneReachabilityEvidence(
  evidence,
  lockfileSha256,
  routerIdentity,
  phase
) {
  requireExactKeys(
    evidence,
    [
      "schemaVersion",
      "mode",
      "variant",
      "status",
      "passed",
      "packageLockSha256",
      "routerVersion",
      "routerDomVersion",
      "sourceTreeSha256",
      "bundleTreeSha256",
      "sourceFileCount",
      "routerImportCount",
      "bundleFileCount",
      "violations",
    ],
    "frontend_router_reachability_evidence_invalid"
  );
  const expectedMode = phase === "final" ? "post-build" : "source-only";
  const failedFields = [];
  if (evidence.schemaVersion !== REACHABILITY_SCHEMA_VERSION) failedFields.push("schemaVersion");
  if (evidence.mode !== expectedMode) failedFields.push("mode");
  if (!["standard", "gopilot", "passpilot"].includes(evidence.variant)) failedFields.push("variant");
  if (evidence.status !== "passed") failedFields.push("status");
  if (evidence.passed !== true) failedFields.push("passed");
  if (evidence.packageLockSha256 !== lockfileSha256) failedFields.push("packageLockSha256");
  if (evidence.routerVersion !== routerIdentity.router.version) failedFields.push("routerVersion");
  if (evidence.routerDomVersion !== routerIdentity.routerDom.version) failedFields.push("routerDomVersion");
  if (evidence.routerVersion !== ROUTER_VERSION) failedFields.push("routerVersionPin");
  if (evidence.routerDomVersion !== ROUTER_VERSION) failedFields.push("routerDomVersionPin");
  if (!SHA256_PATTERN.test(evidence.sourceTreeSha256 ?? "")) failedFields.push("sourceTreeSha256");
  if (!Number.isSafeInteger(evidence.sourceFileCount) ||
      evidence.sourceFileCount <= 0) failedFields.push("sourceFileCount");
  if (!Number.isSafeInteger(evidence.routerImportCount) ||
      evidence.routerImportCount <= 0) failedFields.push("routerImportCount");
  if (!Number.isSafeInteger(evidence.bundleFileCount) ||
      evidence.bundleFileCount < 0) failedFields.push("bundleFileCount");
  if (!Array.isArray(evidence.violations) ||
      evidence.violations.length !== 0) failedFields.push("violations");
  if (failedFields.length > 0) {
    const variantLabel = typeof evidence.variant === "string"
      ? evidence.variant
      : "unknown";
    throw new Error(
      `frontend_router_reachability_evidence_invalid: variant=${variantLabel} fields=${failedFields.join(",")}`
    );
  }
  if (phase === "final" &&
      (!SHA256_PATTERN.test(evidence.bundleTreeSha256 ?? "") ||
        evidence.bundleFileCount <= 0)) {
    throw new Error("frontend_router_reachability_evidence_invalid");
  }
  if (phase === "collect" &&
      (evidence.bundleTreeSha256 !== null || evidence.bundleFileCount !== 0)) {
    throw new Error("frontend_router_reachability_evidence_invalid");
  }
  return {
    schemaVersion: REACHABILITY_SCHEMA_VERSION,
    mode: evidence.mode,
    variant: evidence.variant,
    sourceTreeSha256: evidence.sourceTreeSha256,
    bundleTreeSha256: evidence.bundleTreeSha256,
    sourceFileCount: evidence.sourceFileCount,
    routerImportCount: evidence.routerImportCount,
    bundleFileCount: evidence.bundleFileCount,
  };
}

function validateReachabilityEvidenceSet(
  evidenceSet,
  lockfileSha256,
  routerIdentity,
  phase
) {
  if (!Array.isArray(evidenceSet)) {
    throw new Error("frontend_router_reachability_evidence_invalid");
  }
  const expectedVariants = phase === "final"
    ? ["gopilot", "passpilot", "standard"]
    : ["standard"];
  if (evidenceSet.length !== expectedVariants.length) {
    throw new Error("frontend_router_reachability_evidence_invalid");
  }
  const validated = evidenceSet.map((evidence) =>
      validateOneReachabilityEvidence(
        evidence,
        lockfileSha256,
        routerIdentity,
        phase
      )
  ).sort((left, right) => left.variant.localeCompare(right.variant));
  if (JSON.stringify(validated.map((item) => item.variant)) !==
      JSON.stringify(expectedVariants)) {
    throw new Error(
      `frontend_router_reachability_evidence_invalid: variants=${validated.map((item) => item.variant).join(",")}`
    );
  }
  if (new Set(validated.map((item) => item.sourceTreeSha256)).size !== 1) {
    const summary = validated
      .map((item) => `${item.variant}=${item.sourceTreeSha256.slice(0, 12)}`)
      .join(",");
    throw new Error(
      `frontend_router_reachability_evidence_invalid: sourceTreeSha256 drift ${summary}`
    );
  }
  return validated;
}

function normalizeAdvisoryForReport(advisory, dependencyScope, reviewStatus) {
  return {
    advisoryId: advisory.advisoryId,
    severity: advisory.severity,
    title: advisory.title,
    url: advisory.url,
    dependencyScope,
    vulnerableRanges: advisory.vulnerableRanges,
    advisoryPackages: advisory.advisoryPackages,
    affectedPackages: advisory.affectedPackages,
    fixAvailability: advisory.fixAvailability,
    reviewStatus,
  };
}

function normalizeVulnerabilityRecordForReport(record, reviewStatus) {
  return {
    name: record.name,
    severity: record.severity,
    direct: record.direct,
    dependencyScope: record.dependencyScope,
    resolvedAdvisoryIds: record.resolvedAdvisoryIds,
    nodeCount: record.nodes.length,
    reviewStatus,
  };
}

function reportAuditScope(parsed, advisories, vulnerabilityRecords) {
  return {
    toolExitCode: parsed.toolExitCode,
    counts: parsed.counts,
    advisories,
    vulnerabilityRecords,
  };
}

export function evaluateFrontendDependencyAudit({
  productionAudit,
  fullAudit,
  metadata,
  packageLockText,
  reachabilityEvidenceSet,
  phase = "final",
}) {
  if (phase !== "collect" && phase !== "final") {
    throw new Error("frontend_dependency_audit_phase_invalid");
  }
  const normalizedMetadata = validateMetadata(metadata);
  if (productionAudit.scope !== "production" || fullAudit.scope !== "full") {
    throw new Error("frontend_dependency_audit_scope_pair_invalid");
  }
  const packageLock = parseJsonDocument(
    packageLockText,
    "package_lock_json_invalid"
  );
  const packageLockSha256 = sha256(Buffer.from(packageLockText, "utf8"));
  const routerIdentity = readLockedRouterVersions(packageLock);
  const productionScope = classifyAuditScopeAgainstLock(
    productionAudit,
    packageLock
  );
  const fullScope = classifyAuditScopeAgainstLock(fullAudit, packageLock);
  validateAuditScopeSnapshots(productionScope, fullScope);
  const validReachabilityEvidence = validateReachabilityEvidenceSet(
    reachabilityEvidenceSet,
    packageLockSha256,
    routerIdentity,
    phase
  );

  const productionIds = new Set(productionAudit.advisories.map(
    (advisory) => advisory.advisoryId
  ));
  const productionById = new Map(productionAudit.advisories.map(
    (advisory) => [advisory.advisoryId, advisory]
  ));
  const fullById = new Map(
    fullAudit.advisories.map((advisory) => [advisory.advisoryId, advisory])
  );
  for (const advisoryId of productionIds) {
    const productionAdvisory = productionAudit.advisories.find(
      (advisory) => advisory.advisoryId === advisoryId
    );
    const fullAdvisory = fullById.get(advisoryId);
    if (!fullAdvisory ||
        ["severity", "title", "url"].some(
          (key) => productionAdvisory[key] !== fullAdvisory[key]
        ) ||
        !sameStringSet(
          productionAdvisory.vulnerableRanges,
          fullAdvisory.vulnerableRanges
        ) ||
        !sameStringSet(
          productionAdvisory.advisoryPackages,
          fullAdvisory.advisoryPackages
        ) ||
        !sameStringSet(
          productionAdvisory.affectedPackages,
          fullAdvisory.affectedPackages
        ) ||
        JSON.stringify(productionAdvisory.fixAvailability) !==
          JSON.stringify(fullAdvisory.fixAvailability)) {
      throw new Error("frontend_dependency_audit_scope_drift");
    }
  }
  for (const [advisoryId, scopes] of fullScope.advisoryScopes) {
    if (scopes.has("production") && !productionIds.has(advisoryId)) {
      throw new Error("frontend_dependency_audit_scope_drift");
    }
  }

  const blockingIds = new Set();
  const productionAdvisories = productionAudit.advisories.map((advisory) => {
    const reviewStatus = BLOCKING_SEVERITIES.has(advisory.severity)
      ? "blocking-production"
      : "nonblocking-severity";
    if (reviewStatus === "blocking-production") {
      blockingIds.add(advisory.advisoryId);
    }
    return normalizeAdvisoryForReport(advisory, "production", reviewStatus);
  });

  const productionReview = new Map(
    productionAdvisories.map((advisory) => [
      advisory.advisoryId,
      advisory.reviewStatus,
    ])
  );
  const productionRecordReview = new Map();
  const blockingRecordNames = new Set();
  const productionVulnerabilityRecords = productionScope.records.map(
    (record) => {
      let reviewStatus = "nonblocking-severity";
      if (BLOCKING_SEVERITIES.has(record.severity)) {
        const resolvedBlocking = record.resolvedAdvisoryIds.filter(
          (advisoryId) =>
            BLOCKING_SEVERITIES.has(productionById.get(advisoryId)?.severity)
        );
        if (resolvedBlocking.length === 0) {
          throw new Error("frontend_dependency_audit_record_unresolved");
        }
        reviewStatus = "blocking-production";
        blockingRecordNames.add(record.name);
        for (const advisoryId of resolvedBlocking) {
          blockingIds.add(advisoryId);
        }
      }
      productionRecordReview.set(record.name, reviewStatus);
      return normalizeVulnerabilityRecordForReport(record, reviewStatus);
    }
  );
  const fullAdvisories = fullAudit.advisories.map((advisory) => {
    const advisoryScopes = fullScope.advisoryScopes.get(advisory.advisoryId);
    const dependencyScope = advisoryScopes?.has("production")
      ? "production"
      : "development";
    const reviewStatus = dependencyScope === "production"
      ? productionReview.get(advisory.advisoryId)
      : "reported-development";
    return normalizeAdvisoryForReport(
      advisory,
      dependencyScope,
      reviewStatus
    );
  });
  const fullVulnerabilityRecords = fullScope.records.map((record) => {
    const reviewStatus = record.dependencyScope === "production"
      ? productionRecordReview.get(record.name)
      : "reported-development";
    if (!reviewStatus) {
      throw new Error("frontend_dependency_audit_scope_drift");
    }
    return normalizeVulnerabilityRecordForReport(record, reviewStatus);
  });

  const status =
    blockingIds.size === 0 && blockingRecordNames.size === 0
      ? "passed"
      : "blocked";
  const report = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    phase,
    status,
    commitSha: normalizedMetadata.commitSha,
    packageLockSha256,
    runtime: {
      nodeVersion: normalizedMetadata.nodeVersion,
      npmVersion: normalizedMetadata.npmVersion,
    },
    routerReachability: {
      schemaVersion: REACHABILITY_SCHEMA_VERSION,
      router: routerIdentity.router,
      routerDom: routerIdentity.routerDom,
      evidence: validReachabilityEvidence,
    },
    production: reportAuditScope(
      productionAudit,
      productionAdvisories,
      productionVulnerabilityRecords
    ),
    full: reportAuditScope(
      fullAudit,
      fullAdvisories,
      fullVulnerabilityRecords
    ),
    review: {
      status,
      productionHighCriticalAdvisoryCount:
        productionAdvisories.filter(
           (advisory) => BLOCKING_SEVERITIES.has(advisory.severity)
         ).length,
      blockingAdvisoryCount: blockingIds.size,
      blockingAdvisoryIds: [...blockingIds].sort(),
      blockingVulnerabilityRecordCount: blockingRecordNames.size,
      blockingVulnerabilityRecordNames: [...blockingRecordNames].sort(),
      developmentAdvisoryCount:
        fullAdvisories.filter(
          (advisory) => advisory.dependencyScope === "development"
        ).length,
    },
  };
  return report;
}

function markdownEscape(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

export function renderFrontendDependencyAuditMarkdown(report) {
  const lines = [
    "# Frontend dependency audit",
    "",
    `- Schema: \`${markdownEscape(report.schemaVersion)}\``,
    `- Phase: \`${markdownEscape(report.phase)}\``,
    `- Status: **${markdownEscape(report.status)}**`,
    `- Commit: \`${markdownEscape(report.commitSha)}\``,
    `- Package lock SHA-256: \`${markdownEscape(report.packageLockSha256)}\``,
    `- Node/npm: \`${markdownEscape(report.runtime.nodeVersion)}\` / \`${markdownEscape(report.runtime.npmVersion)}\``,
    "",
    "## Production gate",
    "",
    `Blocking advisories: **${report.review.blockingAdvisoryCount}**; blocking vulnerability records: **${report.review.blockingVulnerabilityRecordCount}**.`,
    "",
    "| Advisory | Severity | Scope | Review | Fix availability |",
    "|---|---:|---|---|---|",
  ];
  const advisories = report.full.advisories;
  if (advisories.length === 0) {
    lines.push("| None | — | — | — | — |");
  } else {
    for (const advisory of advisories) {
      const fixes = advisory.fixAvailability.map((fix) => {
        if (!fix.available) return "none";
        if (fix.name && fix.version) {
          return `${fix.name}@${fix.version}${fix.isSemVerMajor ? " (major)" : ""}`;
        }
        return "available";
      }).join(", ");
      lines.push(
        `| ${markdownEscape(advisory.advisoryId)} | ${markdownEscape(advisory.severity)} | ${markdownEscape(advisory.dependencyScope)} | ${markdownEscape(advisory.reviewStatus)} | ${markdownEscape(fixes)} |`
      );
    }
  }
  lines.push(
    "",
    "## Counts",
    "",
    `- Production vulnerability records: ${report.production.counts.vulnerabilityRecords.total}`,
    `- Production advisory IDs: ${report.production.counts.advisoryIds.total}`,
    `- Full-tree vulnerability records: ${report.full.counts.vulnerabilityRecords.total}`,
    `- Full-tree advisory IDs: ${report.full.counts.advisoryIds.total}`,
    `- Development-only advisory IDs: ${report.review.developmentAdvisoryCount}`,
    ""
  );
  return `${lines.join("\n")}\n`;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    invocationError: result.error ?? null,
  };
}

function gitExecutable() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function runNpmCommand(args, projectRoot) {
  if (process.platform === "win32") {
    return runCommand(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "npm", ...args],
      projectRoot
    );
  }
  return runCommand("npm", args, projectRoot);
}

const FULL_TREE_INCLUDE_FLAGS = [
  "--include=dev",
  "--include=optional",
  "--include=peer",
];

// npm's default fetch-timeout is five minutes. The bulk advisory endpoint
// (registry.npmjs.org/-/npm/v1/security/advisories/bulk) answers the full
// dependency tree slowly and with high variance: on 2026-09-04 the same query
// took 2m29s on one attempt and exceeded 5m on the next, both from a healthy
// network. On a timeout npm still exits 0 and prints
// {"message":"network timeout at: ..."} on stdout, which has no
// auditReportVersion and used to surface here as npm_audit_schema_invalid --
// an upstream stall misreported as a malformed document. Waiting longer asks
// the same question and keeps the gate exactly as strict.
const AUDIT_FETCH_TIMEOUT_FLAG = "--fetch-timeout=600000";

function validateFullTreeNpmConfiguration(result) {
  if (result.invocationError ||
      result.exitCode !== 0 ||
      typeof result.stderr !== "string") {
    throw new Error("npm_audit_full_scope_config_failed");
  }
  const configuration = parseJsonDocument(
    result.stdout,
    "npm_audit_full_scope_config_invalid"
  );
  if (!isRecord(configuration) ||
      !Array.isArray(configuration.include) ||
      !Array.isArray(configuration.omit) ||
      configuration.include.some((value) => typeof value !== "string") ||
      configuration.omit.some((value) => typeof value !== "string") ||
      !sameStringSet(configuration.include, ["dev", "optional", "peer"]) ||
      configuration.omit.length !== 0) {
    throw new Error("npm_audit_full_scope_config_invalid");
  }
}

export function runNpmAudit(
  scope,
  projectRoot,
  npmRunner = runNpmCommand
) {
  if (scope === "production") {
    return npmRunner(["audit", "--omit=dev", "--json", AUDIT_FETCH_TIMEOUT_FLAG], projectRoot);
  }
  if (scope !== "full") {
    throw new Error("npm_audit_scope_invalid");
  }

  const configuration = npmRunner(
    ["config", "list", "--json", ...FULL_TREE_INCLUDE_FLAGS],
    projectRoot
  );
  validateFullTreeNpmConfiguration(configuration);
  return npmRunner(
    ["audit", ...FULL_TREE_INCLUDE_FLAGS, "--json", AUDIT_FETCH_TIMEOUT_FLAG],
    projectRoot
  );
}

function parseArguments(argv) {
  const options = {};
  const valueOptions = new Set([
    "project-root",
    "reachability-evidence",
    "json-output",
    "markdown-output",
    "production-json",
    "production-exit-code",
    "full-json",
    "full-exit-code",
    "metadata-json",
    "phase",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || !valueOptions.has(token.slice(2))) {
      throw new Error("frontend_dependency_audit_arguments_invalid");
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error("frontend_dependency_audit_arguments_invalid");
    }
    const key = token.slice(2);
    if (key !== "reachability-evidence" && Object.hasOwn(options, key)) {
      throw new Error("frontend_dependency_audit_arguments_invalid");
    }
    if (key === "reachability-evidence") {
      options[key] ??= [];
      options[key].push(argv[index + 1]);
    } else {
      options[key] = argv[index + 1];
    }
    index += 1;
  }
  return options;
}

function readInjectedAudit(options, prefix, scope) {
  const jsonPath = options[`${prefix}-json`];
  const exitCodeText = options[`${prefix}-exit-code`];
  if (!jsonPath || !/^(?:0|1)$/.test(exitCodeText ?? "")) {
    throw new Error("frontend_dependency_audit_injection_invalid");
  }
  return parseNpmAuditV2Result({
    scope,
    exitCode: Number(exitCodeText),
    stdout: readFileSync(resolve(jsonPath), "utf8"),
  });
}

function resolveRealMetadata(projectRoot) {
  const gitResult = runCommand(
    gitExecutable(),
    ["rev-parse", "HEAD"],
    projectRoot
  );
  const npmResult = runNpmCommand(["--version"], projectRoot);
  const commitSha = gitResult.stdout.trim();
  const npmVersion = npmResult.stdout.trim();
  if (gitResult.invocationError || gitResult.exitCode !== 0 ||
      npmResult.invocationError || npmResult.exitCode !== 0) {
    throw new Error("frontend_dependency_audit_metadata_command_failed");
  }
  return {
    commitSha,
    nodeVersion: process.version,
    npmVersion,
    evaluatedAtUtc: new Date().toISOString(),
  };
}

export function runFrontendDependencyAuditCli(argv) {
  const options = parseArguments(argv);
  const projectRoot = resolve(options["project-root"] ?? process.cwd());
  const phase = options.phase ?? "final";
  const requiredPaths = [
    "json-output",
    "markdown-output",
  ];
  if (requiredPaths.some((key) => !options[key]) ||
      !Array.isArray(options["reachability-evidence"]) ||
      options["reachability-evidence"].length === 0) {
    throw new Error("frontend_dependency_audit_arguments_invalid");
  }

  const anyInjected = Boolean(
    options["production-json"] ||
    options["production-exit-code"] ||
    options["full-json"] ||
    options["full-exit-code"] ||
    options["metadata-json"]
  );
  const allInjected = Boolean(
    options["production-json"] &&
    options["production-exit-code"] &&
    options["full-json"] &&
    options["full-exit-code"] &&
    options["metadata-json"]
  );
  if (anyInjected !== allInjected) {
    throw new Error("frontend_dependency_audit_injection_invalid");
  }

  const productionAudit = allInjected
    ? readInjectedAudit(options, "production", "production")
    : parseNpmAuditV2Result({
      scope: "production",
      ...runNpmAudit("production", projectRoot),
    });
  const fullAudit = allInjected
    ? readInjectedAudit(options, "full", "full")
    : parseNpmAuditV2Result({
      scope: "full",
      ...runNpmAudit("full", projectRoot),
    });
  const metadata = allInjected
    ? parseJsonDocument(
      readFileSync(resolve(options["metadata-json"]), "utf8"),
      "frontend_audit_metadata_invalid"
    )
    : resolveRealMetadata(projectRoot);
  const packageLockText = readFileSync(
    resolve(projectRoot, "package-lock.json"),
    "utf8"
  );
  const reachabilityEvidenceSet = options["reachability-evidence"].map(
    (evidencePath) =>
      parseJsonDocument(
        readFileSync(resolve(evidencePath), "utf8"),
        "frontend_router_reachability_evidence_invalid"
      )
  );
  const report = evaluateFrontendDependencyAudit({
    productionAudit,
    fullAudit,
    metadata,
    packageLockText,
    reachabilityEvidenceSet,
    phase,
  });
  const jsonOutput = resolve(options["json-output"]);
  const markdownOutput = resolve(options["markdown-output"]);
  mkdirSync(dirname(jsonOutput), { recursive: true });
  mkdirSync(dirname(markdownOutput), { recursive: true });
  writeFileSync(jsonOutput, stableJson(report), "utf8");
  writeFileSync(
    markdownOutput,
    renderFrontendDependencyAuditMarkdown(report),
    "utf8"
  );
  return report;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const report = runFrontendDependencyAuditCli(process.argv.slice(2));
    process.stdout.write(`${report.status}\n`);
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write("frontend_dependency_audit_invalid\n");
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
