import assert from 'node:assert/strict';
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
  ROUTER_REACHABILITY_EVIDENCE_VERSION,
  evaluateRouterReachability,
  runRouterReachabilityCli,
} from './check-router-reachability.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '..');
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

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createFixture({
  source = ALLOWED_SOURCE,
  packageRouterDomVersion = REQUIRED_ROUTER_VERSION,
  lockRouterDomVersion = REQUIRED_ROUTER_VERSION,
  lockRouterVersion = REQUIRED_ROUTER_VERSION,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'router-reachability-'));
  const packageJsonPath = path.join(root, 'package.json');
  const packageLockPath = path.join(root, 'package-lock.json');
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
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, 'App.jsx'), source, 'utf8');

  return {
    root,
    packageJsonPath,
    packageLockPath,
    sourceRoot,
    distRoot,
    outputPath,
  };
}

async function evaluate(fixture, overrides = {}) {
  return evaluateRouterReachability({
    packageJsonPath: fixture.packageJsonPath,
    packageLockPath: fixture.packageLockPath,
    sourceRoot: fixture.sourceRoot,
    mode: 'source-only',
    variant: 'standard',
    ...overrides,
  });
}

test('accepts the current declarative source tree with exact Router identity', async () => {
  const packageJsonPath = path.join(APP_ROOT, 'package.json');
  const packageLockPath = path.join(APP_ROOT, 'package-lock.json');

  const first = await evaluateRouterReachability({
    packageJsonPath,
    packageLockPath,
    sourceRoot: path.join(APP_ROOT, 'src'),
    mode: 'source-only',
    variant: 'standard',
  });
  const second = await evaluateRouterReachability({
    packageJsonPath,
    packageLockPath,
    sourceRoot: path.join(APP_ROOT, 'src'),
    mode: 'source-only',
    variant: 'standard',
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

test('rejects comment-interleaved Router module references without matching inert text', async (t) => {
  const forbiddenFixture = await createFixture({
    source: `${ALLOWED_SOURCE}
import /* side effect */ 'react-router/rsc';
const dynamicRsc = import(/* dynamic */ 'react-router/rsc');
const requiredRsc = require(/* commonjs */ 'react-router/rsc');
export /* re-export */ { RSCHydratedRouter } /* source */ from /* module */ 'react-router/rsc';
import /* declaration */ { createStaticHandler } /* source */ from /* module */ 'react-router/server';
`,
  });
  t.after(() =>
    rm(forbiddenFixture.root, { recursive: true, force: true })
  );

  const forbidden = await evaluate(forbiddenFixture);
  assert.equal(forbidden.passed, false);
  const moduleViolations = forbidden.violations.filter(
    (entry) => entry.code === 'source.forbidden-router-module'
  );
  assert.equal(moduleViolations.length, 5, JSON.stringify(forbidden.violations));
  assert.ok(
    moduleViolations.some(
      (entry) => entry.rule === 'direct-or-internal-router-import'
    )
  );
  assert.equal(
    moduleViolations.filter(
      (entry) => entry.rule === 'side-effect-dynamic-require-or-reexport'
    ).length,
    4
  );

  const inertFixture = await createFixture({
    source: `${ALLOWED_SOURCE}
const quoted = "import(/* comment */ 'react-router/rsc')";
const templated = \`require(/* comment */ 'react-router/rsc')\`;
// import /* comment */ 'react-router/rsc';
/* require(
  'react-router/rsc'
); */
`,
  });
  t.after(() => rm(inertFixture.root, { recursive: true, force: true }));

  const inert = await evaluate(inertFixture);
  assert.equal(inert.passed, true, JSON.stringify(inert.violations));
});

test('uses parsed syntax for regexes, template imports, and require variants', async (t) => {
  const fixture = await createFixture({
    source: `${ALLOWED_SOURCE}
const inertRegex = /import\\(\\s*['"]react-router\\/rsc['"]\\s*\\)/;
const templateRsc = import(\`react-router/rsc\`);
const interpolatedTemplateRsc = import(\`react-router/\${'rsc'}\`);
const dynamicTemplateRsc = import(\`react-router/\${routerEntry}\`);
const concatenatedRsc = import('react-' + 'router/rsc');
const moduleRsc = module.require('react-router/rsc');
const computedModuleRsc = module['require']('react-router/rsc');
const globalRsc = globalThis.require('react-router/rsc');
const optionalRsc = require?.('react-router/rsc');
const optionalModuleRsc = module.require?.('react-router/rsc');
const optionalMemberRsc = module?.require('react-router/rsc');
const optionalGlobalRsc = globalThis?.require?.('react-router/rsc');
`,
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evidence = await evaluate(fixture);
  assert.equal(evidence.passed, false);
  const moduleViolations = evidence.violations.filter(
    (entry) =>
      entry.code === 'source.forbidden-router-module' &&
      entry.rule === 'side-effect-dynamic-require-or-reexport'
  );
  assert.equal(moduleViolations.length, 11, JSON.stringify(evidence.violations));

  const regexOnly = await createFixture({
    source: `${ALLOWED_SOURCE}
const inertRegex = /import\\(\\s*['"]react-router\\/rsc['"]\\s*\\)/;
`,
  });
  t.after(() => rm(regexOnly.root, { recursive: true, force: true }));
  const inertEvidence = await evaluate(regexOnly);
  assert.equal(inertEvidence.passed, true, JSON.stringify(inertEvidence.violations));
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

test('scans root configs, nested build code, and server entries outside src', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(
    path.join(fixture.root, 'vite.config.mts'),
    "import { reactRouter } from '@react-router/dev/vite';\nexport default reactRouter();\n",
    'utf8'
  );
  await writeFile(
    path.join(fixture.root, 'react-router.config.ts'),
    'export default {};\n',
    'utf8'
  );
  await mkdir(path.join(fixture.root, 'build'), { recursive: true });
  await writeFile(
    path.join(fixture.root, 'build', 'router-plugin.mjs'),
    "const rsc = import('react-router/rsc');\nexport default rsc;\n",
    'utf8'
  );
  await mkdir(path.join(fixture.root, 'server'), { recursive: true });
  await writeFile(
    path.join(fixture.root, 'server', 'entry.cts'),
    "const server = require('react-dom/server.node');\nmodule.exports = server;\n",
    'utf8'
  );

  const evidence = await evaluate(fixture);
  assert.equal(evidence.passed, false);
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.file === 'vite.config.mts' &&
        entry.code === 'source.forbidden-router-module' &&
        entry.rule === 'direct-or-internal-router-import'
    ),
    JSON.stringify(evidence.violations)
  );
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.file === 'react-router.config.ts' &&
        entry.code === 'source.forbidden-router-api' &&
        entry.rule === 'framework-config-file'
    ),
    JSON.stringify(evidence.violations)
  );
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.file === 'build/router-plugin.mjs' &&
        entry.code === 'source.forbidden-router-module'
    ),
    JSON.stringify(evidence.violations)
  );
  assert.ok(
    evidence.violations.some(
      (entry) =>
        entry.file === 'server/entry.cts' &&
        entry.code === 'source.forbidden-react-dom-module' &&
        entry.rule === 'ssr-react-dom-module'
    ),
    JSON.stringify(evidence.violations)
  );
});

test('binds project code into the source hash and excludes generated trees', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(
    path.join(fixture.root, 'vite.config.js'),
    "export default { build: { sourcemap: false } };\n",
    'utf8'
  );
  for (const directory of ['node_modules', 'dist', 'audit-evidence']) {
    await mkdir(path.join(fixture.root, directory), { recursive: true });
    await writeFile(
      path.join(fixture.root, directory, 'ignored-server.mjs'),
      "import { renderToString } from 'react-dom/server';\n",
      'utf8'
    );
  }

  const first = await evaluate(fixture);
  assert.equal(first.passed, true, JSON.stringify(first.violations));
  assert.ok(first.sourceFileCount >= 2);

  await writeFile(
    path.join(fixture.root, 'vite.config.js'),
    "export default { build: { sourcemap: true } };\n",
    'utf8'
  );
  const projectCodeChanged = await evaluate(fixture);
  assert.equal(
    projectCodeChanged.passed,
    true,
    JSON.stringify(projectCodeChanged.violations)
  );
  assert.notEqual(projectCodeChanged.sourceTreeSha256, first.sourceTreeSha256);
  assert.equal(projectCodeChanged.sourceFileCount, first.sourceFileCount);

  await writeFile(
    path.join(fixture.root, 'audit-evidence', 'ignored-server.mjs'),
    "import { renderToPipeableStream } from 'react-dom/server.node';\n",
    'utf8'
  );
  const generatedEvidenceChanged = await evaluate(fixture);
  assert.equal(
    generatedEvidenceChanged.passed,
    true,
    JSON.stringify(generatedEvidenceChanged.violations)
  );
  assert.equal(
    generatedEvidenceChanged.sourceTreeSha256,
    projectCodeChanged.sourceTreeSha256
  );
});

test('excludes only generated Capacitor public assets while scanning adjacent Android files', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const baseline = await evaluate(fixture);

  for (const application of ['gopilot', 'passpilot']) {
    const publicAssets = path.join(
      fixture.root,
      `android-${application}`,
      'app',
      'src',
      'main',
      'assets',
      'public'
    );
    await mkdir(publicAssets, { recursive: true });
    await writeFile(
      path.join(publicAssets, 'ignored-server.mjs'),
      "import { renderToString } from 'react-dom/server';\n",
      'utf8'
    );
  }

  const generatedAssetsAdded = await evaluate(fixture);
  assert.equal(
    generatedAssetsAdded.passed,
    true,
    JSON.stringify(generatedAssetsAdded.violations)
  );
  assert.equal(generatedAssetsAdded.sourceFileCount, baseline.sourceFileCount);
  assert.equal(
    generatedAssetsAdded.sourceTreeSha256,
    baseline.sourceTreeSha256
  );

  const adjacentAssets = path.join(
    fixture.root,
    'android-gopilot',
    'app',
    'src',
    'main',
    'assets'
  );
  await writeFile(
    path.join(adjacentAssets, 'checked-server.mjs'),
    "import { renderToString } from 'react-dom/server';\n",
    'utf8'
  );

  const adjacentFileAdded = await evaluate(fixture);
  assert.equal(adjacentFileAdded.passed, false);
  assert.ok(
    adjacentFileAdded.violations.some(
      (entry) =>
        entry.file ===
          'android-gopilot/app/src/main/assets/checked-server.mjs' &&
        entry.code === 'source.forbidden-react-dom-module' &&
        entry.rule === 'ssr-react-dom-module'
    ),
    JSON.stringify(adjacentFileAdded.violations)
  );
});

test('scans and hash-binds generated-looking directories nested under shipped source', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const shippedCoverage = path.join(fixture.sourceRoot, 'coverage');
  const shippedDist = path.join(fixture.sourceRoot, 'dist');
  await mkdir(shippedCoverage, { recursive: true });
  await mkdir(shippedDist, { recursive: true });
  await writeFile(
    path.join(shippedCoverage, 'feature.mjs'),
    'export const shippedCoverageFeature = true;\n',
    'utf8'
  );
  await writeFile(
    path.join(shippedDist, 'feature.mjs'),
    'export const shippedDistFeature = true;\n',
    'utf8'
  );

  const first = await evaluate(fixture);
  assert.equal(first.passed, true, JSON.stringify(first.violations));
  assert.equal(first.sourceFileCount, 3);

  await writeFile(
    path.join(shippedCoverage, 'feature.mjs'),
    'export const shippedCoverageFeature = false;\n',
    'utf8'
  );
  const hashChanged = await evaluate(fixture);
  assert.equal(hashChanged.passed, true, JSON.stringify(hashChanged.violations));
  assert.notEqual(hashChanged.sourceTreeSha256, first.sourceTreeSha256);
  assert.equal(hashChanged.sourceFileCount, first.sourceFileCount);

  await writeFile(
    path.join(shippedDist, 'feature.mjs'),
    "const server = import(/* shipped */ 'react-router/rsc');\nexport default server;\n",
    'utf8'
  );
  const forbidden = await evaluate(fixture);
  assert.equal(forbidden.passed, false);
  assert.ok(
    forbidden.violations.some(
      (entry) =>
        entry.file === 'src/dist/feature.mjs' &&
        entry.code === 'source.forbidden-router-module'
    ),
    JSON.stringify(forbidden.violations)
  );
});

test('rejects a narrowed source root that could evade project scanning', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const narrowedRoot = path.join(fixture.root, 'client');
  await mkdir(narrowedRoot, { recursive: true });
  await writeFile(path.join(narrowedRoot, 'App.jsx'), ALLOWED_SOURCE, 'utf8');

  const evidence = await evaluate(fixture, { sourceRoot: narrowedRoot });
  assert.equal(evidence.passed, false);
  assert.ok(
    evidence.violations.some((entry) => entry.code === 'source.root-invalid')
  );
  assert.equal(evidence.sourceTreeSha256, null);
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

test('fails closed on package and lock Router version drift', async (t) => {
  const fixture = await createFixture({
    packageRouterDomVersion: '^7.18.2',
    lockRouterVersion: '7.17.0',
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evidence = await evaluate(fixture);
  assert.equal(evidence.passed, false);
  const codes = new Set(evidence.violations.map((entry) => entry.code));
  assert.ok(codes.has('identity.package-router-dom-version'));
  assert.ok(codes.has('identity.lock-router-edge-version'));
  assert.ok(codes.has('identity.lock-router-version'));
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
      '--source-root',
      fixture.sourceRoot,
      '--mode',
      'source-only',
      '--variant',
      'standard',
      '--output',
      fixture.outputPath,
    ]
  );
  assert.equal(exitCode, 1);
  const persisted = await readFile(fixture.outputPath, 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes(fixture.root), false);
  assert.equal(JSON.parse(persisted).schemaVersion, ROUTER_REACHABILITY_EVIDENCE_VERSION);
});
