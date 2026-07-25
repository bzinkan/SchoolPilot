import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  REQUIRED_ROUTER_VERSION,
  ROUTER_ADVISORY_ID,
  ROUTER_DISPOSITION_SCHEMA_VERSION,
  ROUTER_REACHABILITY_EVIDENCE_VERSION,
  evaluateRouterReachability,
  runRouterReachabilityCli,
} from './check-router-reachability.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '..');
const FIXED_NOW = new Date('2026-07-24T12:00:00.000Z');
const ALLOWED_SOURCE = `
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

export const surface = [
  BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes,
  useLocation, useNavigate, useParams, useSearchParams, createPortal, createRoot,
];
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createFixture({
  source = ALLOWED_SOURCE,
  packageRouterDomVersion = REQUIRED_ROUTER_VERSION,
  lockRouterDomVersion = REQUIRED_ROUTER_VERSION,
  lockRouterVersion = REQUIRED_ROUTER_VERSION,
  dispositionLockHash = null,
  expiresAtUtc = '2026-08-24T00:00:00Z',
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'router-reachability-'));
  const packageJsonPath = path.join(root, 'package.json');
  const packageLockPath = path.join(root, 'package-lock.json');
  const dispositionPath = path.join(root, 'disposition.json');
  const sourceRoot = path.join(root, 'src');
  const distRoot = path.join(root, 'dist');
  const outputPath = path.join(root, 'evidence.json');

  const packageJson = {
    name: 'fixture',
    dependencies: {
      'react-router-dom': packageRouterDomVersion,
    },
  };
  const packageLock = {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: {
          'react-router-dom': lockRouterDomVersion,
        },
      },
      'node_modules/react-router-dom': {
        version: lockRouterDomVersion,
        dependencies: {
          'react-router': lockRouterVersion,
        },
      },
      'node_modules/react-router': {
        version: lockRouterVersion,
      },
    },
  };
  await writeJson(packageJsonPath, packageJson);
  await writeJson(packageLockPath, packageLock);
  const lockBytes = await readFile(packageLockPath);
  await writeJson(dispositionPath, {
    schemaVersion: ROUTER_DISPOSITION_SCHEMA_VERSION,
    advisoryId: ROUTER_ADVISORY_ID,
    expiresAtUtc,
    packageLockSha256: dispositionLockHash ?? sha256(lockBytes),
    router: {
      packageName: 'react-router',
      version: REQUIRED_ROUTER_VERSION,
    },
    routerDom: {
      packageName: 'react-router-dom',
      version: REQUIRED_ROUTER_VERSION,
    },
    reachabilityEvidenceVersion: ROUTER_REACHABILITY_EVIDENCE_VERSION,
  });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, 'App.jsx'), source, 'utf8');

  return {
    root,
    packageJsonPath,
    packageLockPath,
    dispositionPath,
    sourceRoot,
    distRoot,
    outputPath,
  };
}

async function evaluate(fixture, overrides = {}) {
  return evaluateRouterReachability({
    packageJsonPath: fixture.packageJsonPath,
    packageLockPath: fixture.packageLockPath,
    dispositionPath: fixture.dispositionPath,
    sourceRoot: fixture.sourceRoot,
    mode: 'source-only',
    variant: 'standard',
    now: FIXED_NOW,
    ...overrides,
  });
}

test('accepts the current declarative source tree with exact Router identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'router-current-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageJsonPath = path.join(APP_ROOT, 'package.json');
  const packageLockPath = path.join(APP_ROOT, 'package-lock.json');
  const lockBytes = await readFile(packageLockPath);
  const dispositionPath = path.join(root, 'disposition.json');
  await writeJson(dispositionPath, {
    schemaVersion: ROUTER_DISPOSITION_SCHEMA_VERSION,
    advisoryId: ROUTER_ADVISORY_ID,
    expiresAtUtc: '2026-08-24T00:00:00Z',
    packageLockSha256: sha256(lockBytes),
    router: {
      packageName: 'react-router',
      version: REQUIRED_ROUTER_VERSION,
    },
    routerDom: {
      packageName: 'react-router-dom',
      version: REQUIRED_ROUTER_VERSION,
    },
    reachabilityEvidenceVersion: ROUTER_REACHABILITY_EVIDENCE_VERSION,
  });

  const first = await evaluateRouterReachability({
    packageJsonPath,
    packageLockPath,
    dispositionPath,
    sourceRoot: path.join(APP_ROOT, 'src'),
    mode: 'source-only',
    variant: 'standard',
    now: FIXED_NOW,
  });
  const second = await evaluateRouterReachability({
    packageJsonPath,
    packageLockPath,
    dispositionPath,
    sourceRoot: path.join(APP_ROOT, 'src'),
    mode: 'source-only',
    variant: 'standard',
    now: FIXED_NOW,
  });

  assert.equal(first.passed, true, JSON.stringify(first.violations));
  assert.equal(first.status, 'passed');
  assert.equal(first.bundleTreeSha256, null);
  assert.ok(first.routerImportCount > 0);
  assert.match(first.sourceTreeSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first, second, 'evidence must be deterministic');
});

test('rejects direct, internal, data-router, server, and RSC imports', async (t) => {
  const fixture = await createFixture({
    source: `${ALLOWED_SOURCE}
import { createBrowserRouter } from 'react-router-dom';
import { createStaticHandler } from 'react-router/server';
const rsc = import('react-router/rsc');
`,
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evidence = await evaluate(fixture);
  assert.equal(evidence.passed, false);
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.code === 'source.forbidden-router-api' &&
        entry.rule === 'non-declarative-router-import'
    )
  );
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.code === 'source.forbidden-router-module' &&
        entry.rule === 'direct-or-internal-router-import'
    )
  );
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.code === 'source.forbidden-router-module' &&
        entry.rule === 'side-effect-dynamic-require-or-reexport'
    )
  );
});

test('preserves createRoot/createPortal but rejects SSR and hydration imports', async (t) => {
  const fixture = await createFixture({
    source: `${ALLOWED_SOURCE}
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
`,
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evidence = await evaluate(fixture);
  assert.equal(evidence.passed, false);
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.code === 'source.forbidden-react-dom-module' &&
        entry.rule === 'ssr-react-dom-module'
    )
  );
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.code === 'source.forbidden-rendering-api' &&
        entry.rule === 'ssr-render-api'
    )
  );
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.code === 'source.forbidden-rendering-api' &&
        entry.rule === 'hydration-api'
    )
  );
});

test('rejects dynamic, require, side-effect, and re-exported React DOM server modules', async (t) => {
  const fixture = await createFixture({
    source: `${ALLOWED_SOURCE}
import 'react-dom/server';
const browserServer = import('react-dom/server.browser');
const nodeServer = require('react-dom/server.node');
const edgeServer = require('react-dom/server.edge');
export { renderToStaticMarkup } from 'react-dom/server';
`,
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evidence = await evaluate(fixture);
  assert.equal(evidence.passed, false);
  const serverModuleViolations = evidence.violations.filter(
    (entry) =>
      entry.code === 'source.forbidden-react-dom-module' &&
      entry.rule === 'ssr-react-dom-module'
  );
  assert.equal(
    serverModuleViolations.length,
    5,
    JSON.stringify(evidence.violations)
  );
});

test('post-build mode accepts clean assets and rejects vulnerable runtime tokens', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.join(fixture.distRoot, 'assets'), { recursive: true });
  await writeFile(
    path.join(fixture.distRoot, 'index.html'),
    '<script type="module" src="/assets/app.js"></script>',
    'utf8'
  );
  await writeFile(
    path.join(fixture.distRoot, 'assets', 'app.js'),
    'console.log("declarative bundle");',
    'utf8'
  );

  const clean = await evaluate(fixture, {
    mode: 'post-build',
    variant: 'gopilot',
    distRoot: fixture.distRoot,
  });
  assert.equal(clean.passed, true, JSON.stringify(clean.violations));
  assert.equal(clean.variant, 'gopilot');
  assert.match(clean.bundleTreeSha256, /^[a-f0-9]{64}$/);
  assert.equal(clean.bundleFileCount, 2);

  await writeFile(
    path.join(fixture.distRoot, 'assets', 'app.js'),
    'const runtime = "react-server-dom-webpack";',
    'utf8'
  );
  const vulnerable = await evaluate(fixture, {
    mode: 'post-build',
    variant: 'passpilot',
    distRoot: fixture.distRoot,
  });
  assert.equal(vulnerable.passed, false);
  assert.ok(
    vulnerable.violations.some(
      (entry) =>
        entry.code === 'bundle.forbidden-router-token' &&
        entry.rule === 'rsc-runtime'
      )
  );

  await writeFile(
    path.join(fixture.distRoot, 'assets', 'app.js'),
    'const ssr = "react-dom/server.edge renderToReadableStream";',
    'utf8'
  );
  const serverBundle = await evaluate(fixture, {
    mode: 'post-build',
    variant: 'standard',
    distRoot: fixture.distRoot,
  });
  assert.equal(serverBundle.passed, false);
  assert.ok(
    serverBundle.violations.some(
      (entry) =>
        entry.code === 'bundle.forbidden-router-token' &&
        entry.rule === 'ssr-render-runtime'
    )
  );
});

test('post-build mode fails closed when dist or required entries are missing', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const absent = await evaluate(fixture, {
    mode: 'post-build',
    distRoot: fixture.distRoot,
  });
  assert.equal(absent.passed, false);
  assert.ok(
    absent.violations.some((entry) => entry.code === 'bundle.root-invalid')
  );

  await mkdir(fixture.distRoot, { recursive: true });
  await writeFile(path.join(fixture.distRoot, 'readme.txt'), 'not a bundle', 'utf8');
  const incomplete = await evaluate(fixture, {
    mode: 'post-build',
    distRoot: fixture.distRoot,
  });
  assert.equal(incomplete.passed, false);
  assert.ok(
    incomplete.violations.some((entry) => entry.code === 'bundle.index-missing')
  );
  assert.ok(
    incomplete.violations.some((entry) => entry.code === 'bundle.scripts-missing')
  );
});

test('fails closed on package, lock, disposition, and expiration drift', async (t) => {
  const fixture = await createFixture({
    packageRouterDomVersion: '^7.18.0',
    lockRouterVersion: '7.17.0',
    dispositionLockHash: '0'.repeat(64),
    expiresAtUtc: '2026-07-24T12:00:00Z',
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evidence = await evaluate(fixture);
  assert.equal(evidence.passed, false);
  const codes = new Set(evidence.violations.map((entry) => entry.code));
  assert.ok(codes.has('identity.package-router-dom-version'));
  assert.ok(codes.has('identity.lock-router-edge-version'));
  assert.ok(codes.has('identity.lock-router-version'));
  assert.ok(codes.has('identity.disposition-lock-hash'));
  assert.ok(codes.has('identity.disposition-expired'));
});

test('failure evidence and CLI output redact source content and absolute roots', async (t) => {
  const secret = 'student@example.edu bearer-token-value';
  const fixture = await createFixture({
    source: `${ALLOWED_SOURCE}
const privateValue = ${JSON.stringify(secret)};
const forbidden = createCallServer;
`,
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evidence = await evaluate(fixture);
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.passed, false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(fixture.root), false);

  const exitCode = await runRouterReachabilityCli(
    [
      '--package-json',
      fixture.packageJsonPath,
      '--package-lock',
      fixture.packageLockPath,
      '--disposition',
      fixture.dispositionPath,
      '--source-root',
      fixture.sourceRoot,
      '--mode',
      'source-only',
      '--variant',
      'standard',
      '--output',
      fixture.outputPath,
    ],
    { now: FIXED_NOW }
  );
  assert.equal(exitCode, 1);
  const persisted = await readFile(fixture.outputPath, 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes(fixture.root), false);
  assert.equal(JSON.parse(persisted).schemaVersion, ROUTER_REACHABILITY_EVIDENCE_VERSION);
});
