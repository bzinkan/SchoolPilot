import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  evaluateFrontendDependencyAudit,
  parseNpmAuditV2Result,
  renderFrontendDependencyAuditMarkdown,
  runNpmAudit,
} from "../schoolpilot-app/scripts/frontend-dependency-audit.mjs";

type Severity = "info" | "low" | "moderate" | "high" | "critical";

interface AdvisoryFixture {
  id: string;
  name: string;
  severity: Severity;
  title?: string;
  range?: string;
  secret?: string;
}

const ROUTER_ADVISORY = "GHSA-qwww-vcr4-c8h2";
const BRACE_ADVISORY = "GHSA-mh99-v99m-4gvg";
const OTHER_ADVISORY = "GHSA-2345-6789-cfgh";
const COMMIT_SHA = "a".repeat(40);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function auditDocument(advisories: AdvisoryFixture[]) {
  const records = advisories.flatMap((advisory) => {
    const directRecord = {
      name: advisory.name,
      severity: advisory.severity,
      isDirect: advisory.name !== "react-router",
      via: [
        {
          source: 1200000,
          name: advisory.name,
          dependency: advisory.name,
          title: advisory.title ?? (
            advisory.id === ROUTER_ADVISORY
              ? "React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response"
              : `${advisory.name} advisory`
          ),
          url: `https://github.com/advisories/${advisory.id}`,
          severity: advisory.severity,
          range: advisory.range ?? (
            advisory.id === ROUTER_ADVISORY ? ">=7.12.0 <8.3.0" : "<9.0.0"
          ),
          privateContext: advisory.secret,
        },
      ],
      effects: advisory.id === ROUTER_ADVISORY ? ["react-router-dom"] : [],
      range: advisory.range ?? "<9.0.0",
      nodes: [`node_modules/${advisory.name}`],
      fixAvailable: {
        name: advisory.name,
        version: "9.0.0",
        isSemVerMajor: true,
      },
      privateContext: advisory.secret,
    };
    if (advisory.id !== ROUTER_ADVISORY || advisory.name !== "react-router") {
      return [directRecord];
    }
    return [
      directRecord,
      {
        name: "react-router-dom",
        severity: advisory.severity,
        isDirect: true,
        via: ["react-router"],
        effects: [],
        range: ">=7.12.0-pre.0",
        nodes: ["node_modules/react-router-dom"],
        fixAvailable: {
          name: "react-router-dom",
          version: "7.11.0",
          isSemVerMajor: true,
        },
      },
    ];
  });
  const vulnerabilityCounts = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: records.length,
  };
  const vulnerabilities = Object.fromEntries(
    records.map((record) => {
      vulnerabilityCounts[record.severity] += 1;
      return [record.name, record];
    })
  );
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: vulnerabilityCounts,
      dependencies: {
        prod: 100,
        dev: 200,
        optional: 10,
        peer: 1,
        peerOptional: 0,
        total: 311,
      },
    },
    privateContext: "must-not-survive",
  };
}

function auditRecordNames(advisories: AdvisoryFixture[]): string[] {
  return advisories.flatMap((advisory) =>
    advisory.id === ROUTER_ADVISORY && advisory.name === "react-router"
      ? [advisory.name, "react-router-dom"]
      : [advisory.name]
  );
}

function parsedAudit(
  scope: "production" | "full",
  advisories: AdvisoryFixture[],
  exitCode = advisories.length === 0 ? 0 : 1
) {
  return parseNpmAuditV2Result({
    scope,
    exitCode,
    stdout: JSON.stringify(auditDocument(advisories)),
  });
}

function baseContext(options: {
  production?: AdvisoryFixture[];
  full?: AdvisoryFixture[];
  evaluatedAtUtc?: string;
  phase?: "collect" | "final";
  productionLockPackages?: string[];
} = {}) {
  const brace: AdvisoryFixture = {
    id: BRACE_ADVISORY,
    name: "brace-expansion",
    severity: "high",
  };
  const production = options.production ?? [];
  const full = options.full ?? [brace];
  const productionRecordNames = new Set(auditRecordNames(production));
  for (const packageName of options.productionLockPackages ?? []) {
    productionRecordNames.add(packageName);
  }
  const fullRecordNames = new Set(auditRecordNames(full));
  fullRecordNames.add("react-router");
  fullRecordNames.add("react-router-dom");
  const packageEntries = Object.fromEntries(
    [...fullRecordNames].map((name) => [
      `node_modules/${name}`,
      {
        version: name === "react-router" || name === "react-router-dom"
          ? "7.18.2"
          : "1.0.0",
        ...(productionRecordNames.has(name) ||
            name === "react-router" ||
            name === "react-router-dom"
          ? {}
          : { dev: true }),
        ...(name === "react-router-dom"
          ? { dependencies: { "react-router": "7.18.2" } }
          : {}),
      },
    ])
  );
  const packageLockText = `${JSON.stringify({
    name: "schoolpilot-app",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "schoolpilot-app",
        dependencies: { "react-router-dom": "7.18.2" },
      },
      ...packageEntries,
    },
  }, null, 2)}\n`;
  const packageLockSha256 = sha256(packageLockText);
  const phase = options.phase ?? "final";
  const variants = phase === "final"
    ? ["standard", "gopilot", "passpilot"]
    : ["standard"];
  const reachabilityEvidenceSet = variants.map((variant) => ({
    schemaVersion: "frontend-router-reachability-v2",
    mode: phase === "final" ? "post-build" : "source-only",
    variant,
    status: "passed",
    passed: true,
    packageLockSha256,
    routerVersion: "7.18.2",
    routerDomVersion: "7.18.2",
    sourceTreeSha256: "b".repeat(64),
    bundleTreeSha256: phase === "final"
      ? sha256(`bundle-${variant}`)
      : null,
    sourceFileCount: 12,
    routerImportCount: 8,
    bundleFileCount: phase === "final" ? 4 : 0,
    violations: [],
  }));
  return {
    productionAudit: parsedAudit("production", production),
    fullAudit: parsedAudit("full", full),
    metadata: {
      commitSha: COMMIT_SHA,
      nodeVersion: "v22.22.0",
      npmVersion: "11.10.0",
      evaluatedAtUtc:
        options.evaluatedAtUtc ?? "2026-07-24T18:00:00.000Z",
    },
    packageLockText,
    reachabilityEvidenceSet,
    phase,
  };
}

function evaluate(context = baseContext()) {
  return evaluateFrontendDependencyAudit(context);
}

describe("frontend dependency audit engine", () => {
  it("keeps Capacitor CLI tooling-only and runtime packages production-scoped", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve("schoolpilot-app/package.json"), "utf8")
    );
    const packageLock = JSON.parse(
      readFileSync(resolve("schoolpilot-app/package-lock.json"), "utf8")
    );
    const runtimePackages = [
      "@capacitor/android",
      "@capacitor/app",
      "@capacitor/core",
      "@capacitor/haptics",
      "@capacitor/keyboard",
      "@capacitor/network",
      "@capacitor/splash-screen",
      "@capacitor/status-bar",
      "capacitor-secure-storage-plugin",
    ];

    assert.equal(packageJson.dependencies["@capacitor/cli"], undefined);
    assert.equal(packageJson.devDependencies["@capacitor/cli"], "^8.4.1");
    assert.equal(packageJson.overrides, undefined);
    assert.equal(
      packageLock.packages[""].dependencies["@capacitor/cli"],
      undefined
    );
    assert.equal(
      packageLock.packages[""].devDependencies["@capacitor/cli"],
      "^8.4.1"
    );
    assert.equal(packageLock.packages["node_modules/@capacitor/cli"].dev, true);

    for (const packageName of runtimePackages) {
      assert.equal(typeof packageJson.dependencies[packageName], "string");
      assert.equal(packageJson.devDependencies[packageName], undefined);
      assert.equal(
        typeof packageLock.packages[""].dependencies[packageName],
        "string"
      );
      assert.notEqual(
        packageLock.packages[`node_modules/${packageName}`]?.dev,
        true
      );
    }
  });

  it("blocks every production high advisory without exceptions", () => {
    const router: AdvisoryFixture = {
      id: ROUTER_ADVISORY,
      name: "react-router",
      severity: "high",
    };
    const other: AdvisoryFixture = {
      id: OTHER_ADVISORY,
      name: "runtime-package",
      severity: "high",
    };
    const context = baseContext({
      production: [router, other],
      full: [router, other],
    });
    const report = evaluate(context);
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.review.blockingAdvisoryIds, [
      OTHER_ADVISORY,
      ROUTER_ADVISORY,
    ]);
    assert.deepEqual(report.review.blockingVulnerabilityRecordNames, [
      "react-router",
      "react-router-dom",
      "runtime-package",
    ]);
  });

  it("records the fixed Router identity and all final evidence variants", () => {
    const report = evaluate();
    assert.equal(report.status, "passed");
    assert.equal(report.routerReachability.router.version, "7.18.2");
    assert.equal(report.routerReachability.routerDom.version, "7.18.2");
    assert.deepEqual(
      report.routerReachability.evidence.map(
        (evidence: { variant: string }) => evidence.variant
      ),
      ["gopilot", "passpilot", "standard"]
    );
    assert.ok(
      report.routerReachability.evidence.every(
        (evidence: { bundleTreeSha256: string | null }) =>
          typeof evidence.bundleTreeSha256 === "string"
      )
    );
    assert.equal(report.production.advisories.length, 0);
  });

  it("resolves string via edges transitively and rejects missing, cyclic, or severity-conflicting graphs", () => {
    const routerAudit = parsedAudit("production", [{
      id: ROUTER_ADVISORY,
      name: "react-router",
      severity: "high",
    }]);
    const routerDom = routerAudit.vulnerabilityRecords.find(
      (record: { name: string }) => record.name === "react-router-dom"
    );
    assert.deepEqual(routerDom?.resolvedAdvisoryIds, [ROUTER_ADVISORY]);

    const missing = auditDocument([{
      id: OTHER_ADVISORY,
      name: "runtime-package",
      severity: "high",
    }]);
    missing.vulnerabilities["runtime-package"].via = ["missing-package"];
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 1,
        stdout: JSON.stringify(missing),
      })
    , /npm_audit_via_reference_missing/);

    const cyclic = auditDocument([{
      id: OTHER_ADVISORY,
      name: "runtime-package",
      severity: "high",
    }]);
    cyclic.vulnerabilities["runtime-package"].via = ["runtime-package"];
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 1,
        stdout: JSON.stringify(cyclic),
      })
    , /npm_audit_via_cycle/);

    const conflicting = auditDocument([{
      id: OTHER_ADVISORY,
      name: "runtime-package",
      severity: "high",
    }]);
    conflicting.vulnerabilities["runtime-package"].severity = "critical";
    conflicting.metadata.vulnerabilities.high = 0;
    conflicting.metadata.vulnerabilities.critical = 1;
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 1,
        stdout: JSON.stringify(conflicting),
      })
    , /npm_audit_via_severity_conflict/);
  });

  it("merges legitimate multi-range records for one GHSA deterministically", () => {
    const document = auditDocument([{
      id: BRACE_ADVISORY,
      name: "brace-expansion",
      severity: "high",
      range: "<1.1.18",
    }]);
    const firstVia = document.vulnerabilities["brace-expansion"].via[0];
    document.vulnerabilities["brace-expansion"].via.push({
      ...firstVia,
      source: 1200001,
      range: ">=4.0.0 <5.0.9",
    });

    const parsed = parseNpmAuditV2Result({
      scope: "full",
      exitCode: 1,
      stdout: JSON.stringify(document),
    });
    assert.equal(parsed.advisories.length, 1);
    assert.deepEqual(parsed.advisories[0].vulnerableRanges, [
      "<1.1.18",
      ">=4.0.0 <5.0.9",
    ]);
  });

  it("fails when successive audit snapshots hide a production-scoped full-tree finding", () => {
    const runtimeHigh: AdvisoryFixture = {
      id: OTHER_ADVISORY,
      name: "runtime-package",
      severity: "high",
    };
    const context = baseContext({
      full: [runtimeHigh],
      productionLockPackages: ["runtime-package"],
    });
    assert.throws(
      () => evaluate(context),
      /frontend_dependency_audit_scope_drift/
    );
  });

  it("rejects fixed Router lock drift", () => {
    const context = baseContext();
    context.packageLockText = context.packageLockText.replaceAll(
      '"7.18.2"',
      '"7.18.1"'
    );
    assert.throws(
      () => evaluate(context),
      /frontend_router_reachability_evidence_invalid/
    );
  });

  it("rejects missing, duplicate, failed, or drifted reachability evidence", () => {
    const cases = [
      (context: ReturnType<typeof baseContext>) => {
        context.reachabilityEvidenceSet.pop();
      },
      (context: ReturnType<typeof baseContext>) => {
        context.reachabilityEvidenceSet[1].variant = "standard";
      },
      (context: ReturnType<typeof baseContext>) => {
        context.reachabilityEvidenceSet[0].status = "failed";
        context.reachabilityEvidenceSet[0].passed = false;
      },
      (context: ReturnType<typeof baseContext>) => {
        context.reachabilityEvidenceSet[0].packageLockSha256 = "d".repeat(64);
      },
      (context: ReturnType<typeof baseContext>) => {
        context.reachabilityEvidenceSet[0].sourceTreeSha256 = "e".repeat(64);
      },
      (context: ReturnType<typeof baseContext>) => {
        context.reachabilityEvidenceSet[0].bundleTreeSha256 = null;
      },
      (context: ReturnType<typeof baseContext>) => {
        context.reachabilityEvidenceSet[0].schemaVersion =
          "frontend-router-reachability-v1";
      },
      (context: ReturnType<typeof baseContext>) => {
        context.reachabilityEvidenceSet[0].routerVersion = "7.18.1";
      },
    ];
    for (const mutate of cases) {
      const context = baseContext();
      mutate(context);
      assert.throws(
        () => evaluate(context),
        /frontend_router_reachability_evidence_invalid/
      );
    }
  });

  it("accepts hash-identical bundles when distinct variants legitimately build the same surface", () => {
    const context = baseContext();
    context.reachabilityEvidenceSet[0].bundleTreeSha256 =
      context.reachabilityEvidenceSet[1].bundleTreeSha256;
    const report = evaluate(context);
    assert.equal(report.status, "passed");
    assert.deepEqual(
      report.routerReachability.evidence.map(
        (evidence: { variant: string }) => evidence.variant
      ),
      ["gopilot", "passpilot", "standard"]
    );
  });

  it("allows source-only collection but requires one exact standard receipt", () => {
    const context = baseContext({ phase: "collect" });
    const report = evaluate(context);
    assert.equal(report.phase, "collect");
    assert.equal(report.status, "passed");
    assert.deepEqual(
      report.routerReachability.evidence.map(
        (evidence: { variant: string }) => evidence.variant
      ),
      ["standard"]
    );
    assert.equal(
      report.routerReachability.evidence[0].bundleTreeSha256,
      null
    );
  });

  it("reports development-only advisories without blocking production", () => {
    const report = evaluate();
    const brace = report.full.advisories.find(
      (advisory: { advisoryId: string }) =>
        advisory.advisoryId === BRACE_ADVISORY
    );
    assert.equal(report.status, "passed");
    assert.equal(brace?.dependencyScope, "development");
    assert.equal(brace?.reviewStatus, "reported-development");
    assert.equal(report.review.developmentAdvisoryCount, 1);
  });

  it("forces a complete full-tree audit despite inherited npm_config_omit=dev", () => {
    const previousOmit = process.env.npm_config_omit;
    process.env.npm_config_omit = "dev";
    const calls: string[][] = [];
    const runner = (args: string[]) => {
      calls.push([...args]);
      assert.equal(process.env.npm_config_omit, "dev");
      if (args[0] === "config") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            omit: [],
            include: ["dev", "optional", "peer"],
          }),
          stderr: "",
          invocationError: null,
        };
      }
      return {
        exitCode: 1,
        stdout: JSON.stringify(auditDocument([{
          id: BRACE_ADVISORY,
          name: "brace-expansion",
          severity: "high",
        }])),
        stderr: "",
        invocationError: null,
      };
    };

    try {
      const result = runNpmAudit("full", "fixture-root", runner);
      assert.equal(result.exitCode, 1);
      assert.deepEqual(calls, [
        [
          "config",
          "list",
          "--json",
          "--include=dev",
          "--include=optional",
          "--include=peer",
        ],
        [
          "audit",
          "--include=dev",
          "--include=optional",
          "--include=peer",
          "--json",
        ],
      ]);

      assert.throws(
        () => runNpmAudit("full", "fixture-root", (args: string[]) => {
          if (args[0] === "config") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                omit: ["dev"],
                include: ["optional", "peer"],
              }),
              stderr: "",
              invocationError: null,
            };
          }
          throw new Error("audit_must_not_run_after_scope_failure");
        }),
        /npm_audit_full_scope_config_invalid/
      );
    } finally {
      if (previousOmit === undefined) {
        delete process.env.npm_config_omit;
      } else {
        process.env.npm_config_omit = previousOmit;
      }
    }
  });

  it("rejects malformed reports and invalid npm tool semantics", () => {
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 2,
        stdout: "{}",
      })
    , /npm_audit_tool_exit_invalid/);
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 1,
        stdout: "{bad json",
      })
    , /npm_audit_json_invalid/);
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 1,
        stdout: JSON.stringify({ error: { code: "EAI_AGAIN" } }),
      })
    , /npm_audit_schema_invalid/);
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 1,
        stdout: JSON.stringify(auditDocument([])),
      })
    , /npm_audit_exit_findings_mismatch/);
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 0,
        stdout: JSON.stringify(auditDocument([{
          id: OTHER_ADVISORY,
          name: "runtime-package",
          severity: "high",
        }])),
      })
    , /npm_audit_exit_findings_mismatch/);
    assert.throws(() =>
      parseNpmAuditV2Result({
        scope: "production",
        exitCode: 1,
        stdout: "{}",
        invocationError: new Error("spawn failed with private path"),
      })
    , /npm_audit_invocation_failed/);
  });

  it("produces deterministic artifacts without unreviewed audit fields", () => {
    const secret = "tenant-private-secret";
    const runtime: AdvisoryFixture = {
      id: OTHER_ADVISORY,
      name: "runtime-package",
      severity: "high",
      secret,
    };
    const context = baseContext({
      production: [runtime],
      full: [
        runtime,
        {
          id: BRACE_ADVISORY,
          name: "brace-expansion",
          severity: "high",
          secret,
        },
      ],
    });
    const first = evaluate(context);
    const second = evaluate(context);
    const firstJson = `${JSON.stringify(first, null, 2)}\n`;
    const secondJson = `${JSON.stringify(second, null, 2)}\n`;
    const markdown = renderFrontendDependencyAuditMarkdown(first);
    assert.equal(firstJson, secondJson);
    assert.equal(firstJson.includes(secret), false);
    assert.equal(firstJson.includes("privateContext"), false);
    assert.equal(markdown.includes(secret), false);
    assert.match(markdown, /blocking-production/);
    assert.match(markdown, /reported-development/);
  });

  it("supports deterministic injected CLI inputs and writes both artifacts", () => {
    const context = baseContext();
    const root = mkdtempSync(join(tmpdir(), "schoolpilot-frontend-audit-"));
    try {
      mkdirSync(join(root, "evidence"), { recursive: true });
      writeFileSync(join(root, "package-lock.json"), context.packageLockText);
      writeFileSync(
        join(root, "production.json"),
        JSON.stringify(auditDocument([]))
      );
      writeFileSync(
        join(root, "full.json"),
        JSON.stringify(auditDocument([{
          id: BRACE_ADVISORY,
          name: "brace-expansion",
          severity: "high",
        }]))
      );
      writeFileSync(
        join(root, "metadata.json"),
        JSON.stringify(context.metadata)
      );
      const evidencePaths = context.reachabilityEvidenceSet.map(
        (evidence: { variant: string }, index: number) => {
          const path = join(root, `reachability-${index}.json`);
          writeFileSync(path, JSON.stringify(evidence));
          return path;
        }
      );
      const jsonOutput = join(root, "evidence", "audit.json");
      const markdownOutput = join(root, "evidence", "audit.md");
      const script = resolve(
        "schoolpilot-app/scripts/frontend-dependency-audit.mjs"
      );
      const args = [
        script,
        "--project-root",
        root,
        ...evidencePaths.flatMap((path) => [
          "--reachability-evidence",
          path,
        ]),
        "--json-output",
        jsonOutput,
        "--markdown-output",
        markdownOutput,
        "--production-json",
        join(root, "production.json"),
        "--production-exit-code",
        "0",
        "--full-json",
        join(root, "full.json"),
        "--full-exit-code",
        "1",
        "--metadata-json",
        join(root, "metadata.json"),
        "--phase",
        "final",
      ];
      const result = spawnSync(process.execPath, args, {
        cwd: resolve("."),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "passed\n");
      const report = JSON.parse(readFileSync(jsonOutput, "utf8"));
      assert.equal(report.schemaVersion, "frontend-dependency-audit-v2");
      assert.equal(report.status, "passed");
      assert.match(
        readFileSync(markdownOutput, "utf8"),
        /Frontend dependency audit/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
