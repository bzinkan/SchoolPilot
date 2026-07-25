#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

export const ROUTER_REACHABILITY_EVIDENCE_VERSION =
  'frontend-router-reachability-v1';
export const ROUTER_DISPOSITION_SCHEMA_VERSION =
  'frontend-dependency-disposition-v1';
export const ROUTER_ADVISORY_ID = 'GHSA-qwww-vcr4-c8h2';
export const REQUIRED_ROUTER_VERSION = '7.18.0';

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);
const TEXT_BUNDLE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.cjs']);
const VALID_MODES = new Set(['source-only', 'post-build']);
const VALID_VARIANTS = new Set(['standard', 'gopilot', 'passpilot']);
const PROJECT_EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.vite',
  'audit-evidence',
  'coverage',
  'dist',
  'dist-ssr',
  'node_modules',
]);
// The policy implementation and its regression fixtures necessarily contain
// the forbidden literals. They remain part of sourceTreeSha256, but only these
// two exact non-runtime files are exempt from evaluating their fixture text.
const PROJECT_HASH_ONLY_FILES = new Set([
  'scripts/check-router-reachability.mjs',
  'scripts/check-router-reachability.test.mjs',
]);
const ROUTER_CONFIG_FILE_PATTERN =
  /(?:^|\/)react-router\.config\.(?:c|m)?(?:j|t)sx?$/;
const ROUTER_MODULE_PATTERN =
  /^(?:react-router(?:-dom)?(?:\/.*)?|@react-router\/[^/]+(?:\/.*)?)$/;

const ALLOWED_ROUTER_DOM_IMPORTS = new Set([
  'BrowserRouter',
  'Link',
  'Navigate',
  'NavLink',
  'Outlet',
  'Route',
  'Routes',
  'useLocation',
  'useNavigate',
  'useParams',
  'useSearchParams',
]);

const REQUIRED_DECLARATIVE_SURFACE = [
  'BrowserRouter',
  'Link',
  'Navigate',
  'NavLink',
  'Outlet',
  'Route',
  'Routes',
  'useLocation',
  'useNavigate',
  'useParams',
  'useSearchParams',
];

const ALLOWED_REACT_DOM_IMPORTS = new Map([
  ['react-dom', new Set(['createPortal'])],
  ['react-dom/client', new Set(['createRoot'])],
]);

const FORBIDDEN_SOURCE_API_GROUPS = [
  {
    rule: 'data-router-api',
    tokens: [
      'RouterProvider',
      'createBrowserRouter',
      'createHashRouter',
      'createMemoryRouter',
      'createRoutesFromElements',
      'useActionData',
      'useFetcher',
      'useFetchers',
      'useLoaderData',
      'useNavigation',
      'useRevalidator',
      'useRouteError',
      'useRouteLoaderData',
    ],
  },
  {
    rule: 'server-router-api',
    tokens: [
      'HydratedRouter',
      'StaticRouter',
      'StaticRouterProvider',
      'createRequestHandler',
      'createStaticHandler',
      'createStaticRouter',
    ],
  },
  {
    rule: 'rsc-api',
    tokens: [
      'RSCHydratedRouter',
      'RSCStaticRouter',
      'createCallServer',
      'getRSCStream',
      'routeRSCServerRequest',
      'unstable_RSCHydratedRouter',
      'unstable_RSCStaticRouter',
      'unstable_createCallServer',
    ],
  },
  {
    rule: 'framework-route-api',
    tokens: [
      'clientAction',
      'clientLoader',
      'serverAction',
      'serverLoader',
    ],
  },
  {
    code: 'source.forbidden-rendering-api',
    rule: 'ssr-render-api',
    tokens: [
      'prerenderToNodeStream',
      'renderToPipeableStream',
      'renderToReadableStream',
      'renderToStaticMarkup',
      'renderToString',
      'resumeAndPrerender',
      'resumeToPipeableStream',
    ],
  },
  {
    code: 'source.forbidden-rendering-api',
    rule: 'hydration-api',
    tokens: [
      'hydrateRoot',
    ],
  },
];

const FORBIDDEN_SOURCE_PATTERNS = [
  {
    rule: 'route-loader-prop',
    expression: /<Route\b[^>]*\bloader\s*=/g,
  },
  {
    rule: 'route-action-prop',
    expression: /<Route\b[^>]*\baction\s*=/g,
  },
  {
    rule: 'framework-config',
    expression: /\breact-router\.config\b/g,
  },
  {
    rule: 'server-action-directive',
    expression: /(['"])use server\1/g,
  },
  {
    code: 'source.forbidden-rendering-api',
    rule: 'legacy-hydration-call',
    expression: /\b(?:ReactDOM\.)?hydrate\s*\(/g,
  },
];

const FORBIDDEN_BUNDLE_TOKEN_GROUPS = [
  {
    rule: 'rsc-runtime',
    tokens: [
      'RSCHydratedRouter',
      'RSCStaticRouter',
      'createCallServer',
      'getRSCStream',
      'react-server-dom-turbopack',
      'react-server-dom-webpack',
      'routeRSCServerRequest',
      'text/x-component',
      'unstable_RSCHydratedRouter',
      'unstable_RSCStaticRouter',
      'unstable_createCallServer',
    ],
  },
  {
    rule: 'server-action-runtime',
    tokens: [
      'decodeAction',
      'decodeFormState',
      'loadServerAction',
      'server-action',
    ],
  },
  {
    rule: 'server-router-runtime',
    tokens: [
      'StaticRouterProvider',
      'createRequestHandler',
      'createStaticHandler',
      'createStaticRouter',
    ],
  },
  {
    rule: 'ssr-render-runtime',
    tokens: [
      'prerenderToNodeStream',
      'react-dom/server',
      'react-dom/server.browser',
      'react-dom/server.edge',
      'react-dom/server.node',
      'renderToPipeableStream',
      'renderToReadableStream',
      'renderToStaticMarkup',
      'renderToString',
      'resumeAndPrerender',
      'resumeToPipeableStream',
    ],
  },
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function lineForIndex(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function violation(code, extras = {}) {
  return {
    code,
    ...extras,
  };
}

async function readRequiredFile(filePath, code, violations) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      violations.push(violation(code));
      return null;
    }
    return await readFile(filePath);
  } catch {
    violations.push(violation(code));
    return null;
  }
}

async function readJsonFile(filePath, code, violations) {
  const bytes = await readRequiredFile(filePath, code, violations);
  if (!bytes) return { bytes: null, value: null };
  try {
    return {
      bytes,
      value: JSON.parse(bytes.toString('utf8')),
    };
  } catch {
    violations.push(violation(`${code}.invalid-json`));
    return { bytes, value: null };
  }
}

async function collectFiles(root, { extensions = null } = {}) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('invalid-root');
  }

  const files = [];
  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const childPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('symlink-not-allowed');
      }
      if (entry.isDirectory()) {
        await visit(childPath, childRelative);
      } else if (
        entry.isFile() &&
        (!extensions || extensions.has(path.extname(entry.name).toLowerCase()))
      ) {
        files.push({
          absolutePath: childPath,
          relativePath: normalizeRelativePath(childRelative),
        });
      }
    }
  }
  await visit(root, '');
  return files;
}

function isExcludedProjectDirectory(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const [topLevelDirectory] = normalized.split('/');
  if (PROJECT_EXCLUDED_DIRECTORY_NAMES.has(topLevelDirectory)) {
    return true;
  }
  return /^android-(?:gopilot|passpilot)\/app\/build(?:\/|$)/.test(normalized);
}

async function collectProjectSourceFiles(projectRoot) {
  const rootInfo = await lstat(projectRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('invalid-project-root');
  }

  const files = [];
  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const childPath = path.join(current, entry.name);
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        isExcludedProjectDirectory(childRelative)
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error('symlink-not-allowed');
      }
      if (entry.isDirectory()) {
        await visit(childPath, childRelative);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push({
          absolutePath: childPath,
          relativePath: normalizeRelativePath(childRelative),
        });
      }
    }
  }
  await visit(projectRoot, '');
  return files;
}

async function hashTree(files) {
  const manifest = [];
  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    manifest.push({
      path: file.relativePath,
      sha256: sha256(bytes),
      size: bytes.byteLength,
    });
  }
  return sha256(canonicalJson(manifest));
}

function validatePackageIdentity({
  packageJson,
  packageLock,
  disposition,
  packageLockSha256,
  dispositionSha256,
  now,
  violations,
}) {
  const packageRouterDom = packageJson?.dependencies?.['react-router-dom'];
  if (packageRouterDom !== REQUIRED_ROUTER_VERSION) {
    violations.push(violation('identity.package-router-dom-version'));
  }

  const lockRoot = packageLock?.packages?.[''];
  const lockRouterDom = packageLock?.packages?.['node_modules/react-router-dom'];
  const lockRouter = packageLock?.packages?.['node_modules/react-router'];
  if (lockRoot?.dependencies?.['react-router-dom'] !== REQUIRED_ROUTER_VERSION) {
    violations.push(violation('identity.lock-root-router-dom-version'));
  }
  if (lockRouterDom?.version !== REQUIRED_ROUTER_VERSION) {
    violations.push(violation('identity.lock-router-dom-version'));
  }
  if (lockRouterDom?.dependencies?.['react-router'] !== REQUIRED_ROUTER_VERSION) {
    violations.push(violation('identity.lock-router-edge-version'));
  }
  if (lockRouter?.version !== REQUIRED_ROUTER_VERSION) {
    violations.push(violation('identity.lock-router-version'));
  }

  if (disposition?.schemaVersion !== ROUTER_DISPOSITION_SCHEMA_VERSION) {
    violations.push(violation('identity.disposition-schema'));
  }
  if (disposition?.advisoryId !== ROUTER_ADVISORY_ID) {
    violations.push(violation('identity.disposition-advisory'));
  }
  if (
    disposition?.reachabilityEvidenceVersion !==
    ROUTER_REACHABILITY_EVIDENCE_VERSION
  ) {
    violations.push(violation('identity.disposition-evidence-version'));
  }
  if (disposition?.packageLockSha256 !== packageLockSha256) {
    violations.push(violation('identity.disposition-lock-hash'));
  }
  if (
    disposition?.router?.packageName !== 'react-router' ||
    disposition?.router?.version !== REQUIRED_ROUTER_VERSION
  ) {
    violations.push(violation('identity.disposition-router-version'));
  }
  if (
    disposition?.routerDom?.packageName !== 'react-router-dom' ||
    disposition?.routerDom?.version !== REQUIRED_ROUTER_VERSION
  ) {
    violations.push(violation('identity.disposition-router-dom-version'));
  }

  const expiresAtUtc = disposition?.expiresAtUtc;
  if (
    typeof expiresAtUtc !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
      expiresAtUtc
    ) ||
    !Number.isFinite(Date.parse(expiresAtUtc))
  ) {
    violations.push(violation('identity.disposition-expiration'));
  } else if (now.getTime() >= Date.parse(expiresAtUtc)) {
    violations.push(violation('identity.disposition-expired'));
  }

  return {
    dispositionSha256,
    packageLockSha256,
    routerDomVersion:
      typeof lockRouterDom?.version === 'string' ? lockRouterDom.version : null,
    routerVersion:
      typeof lockRouter?.version === 'string' ? lockRouter.version : null,
  };
}

function parseNamedImports(specifiers) {
  if (!Array.isArray(specifiers)) return null;
  const names = [];
  for (const specifier of specifiers) {
    if (specifier?.type !== 'ImportSpecifier') return null;
    const importedName =
      specifier.imported?.type === 'Identifier'
        ? specifier.imported.name
        : specifier.imported?.type === 'StringLiteral'
          ? specifier.imported.value
          : null;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(importedName ?? '')) return null;
    names.push(importedName);
  }
  return names;
}

function parseSource(text, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const plugins = [];
  if (['.jsx', '.tsx'].includes(extension)) plugins.push('jsx');
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) {
    plugins.push([
      'typescript',
      {
        disallowAmbiguousJSXLike: ['.mts', '.cts'].includes(extension),
      },
    ]);
  }
  return parse(text, {
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    createImportExpressions: true,
    errorRecovery: false,
    plugins,
    sourceFilename: relativePath,
    sourceType: 'unambiguous',
  });
}

function staticStringValue(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (
    node?.type === 'BinaryExpression' &&
    node.operator === '+'
  ) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (
    node?.type === 'ParenthesizedExpression' ||
    node?.type === 'TSAsExpression' ||
    node?.type === 'TSTypeAssertion' ||
    node?.type === 'TSNonNullExpression'
  ) {
    return staticStringValue(node.expression);
  }
  if (node?.type !== 'TemplateLiteral') return null;
  let value = '';
  for (let index = 0; index < node.quasis.length; index += 1) {
    const quasi = node.quasis[index];
    const cooked = quasi?.value?.cooked;
    if (typeof cooked !== 'string') return null;
    value += cooked;
    if (index >= node.expressions.length) continue;
    const expressionValue = staticStringValue(node.expressions[index]);
    if (expressionValue === null) return null;
    value += expressionValue;
  }
  return value;
}

function moduleReferenceValue(node) {
  const exact = staticStringValue(node);
  if (exact !== null) return exact;
  if (node?.type !== 'TemplateLiteral') return null;
  const staticShape = node.quasis
    .map((quasi) => quasi?.value?.cooked)
    .filter((value) => typeof value === 'string')
    .join('');
  if (staticShape.startsWith('@react-router/')) {
    return '@react-router/__dynamic-template__';
  }
  if (staticShape.startsWith('react-router')) {
    return 'react-router/__dynamic-template__';
  }
  if (staticShape.startsWith('react-dom')) {
    return 'react-dom/__dynamic-template__';
  }
  return null;
}

function propertyName(member) {
  if (!member?.computed && member?.property?.type === 'Identifier') {
    return member.property.name;
  }
  return staticStringValue(member?.property);
}

function isRequireCallee(node) {
  if (node?.type === 'Identifier') return node.name === 'require';
  if (
    node?.type !== 'MemberExpression' &&
    node?.type !== 'OptionalMemberExpression'
  ) {
    return false;
  }
  return (
    propertyName(node) === 'require' &&
    node.object?.type === 'Identifier' &&
    (node.object.name === 'module' || node.object.name === 'globalThis')
  );
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'loc' ||
      key === 'start' ||
      key === 'end' ||
      key === 'extra' ||
      key === 'errors'
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walkAst(entry, visit);
    } else {
      walkAst(value, visit);
    }
  }
}

function findModuleReferences(text, relativePath) {
  const ast = parseSource(text, relativePath);
  const references = [];
  walkAst(ast, (node) => {
    if (node.type === 'ImportDeclaration') {
      references.push({
        index: node.start ?? 0,
        kind: node.specifiers.length === 0 ? 'side-effect' : 'static',
        moduleName: staticStringValue(node.source),
        specifiers: node.specifiers,
      });
      return;
    }
    if (
      (node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source
    ) {
      references.push({
        index: node.start ?? 0,
        kind: 'reexport',
        moduleName: staticStringValue(node.source),
        specifiers: [],
      });
      return;
    }
    if (node.type === 'ImportExpression') {
      const moduleName = moduleReferenceValue(node.source);
      if (moduleName !== null) {
        references.push({
          index: node.start ?? 0,
          kind: 'dynamic',
          moduleName,
          specifiers: [],
        });
      }
      return;
    }
    if (
      (node.type === 'CallExpression' ||
        node.type === 'OptionalCallExpression') &&
      isRequireCallee(node.callee)
    ) {
      const moduleName = moduleReferenceValue(node.arguments?.[0]);
      if (moduleName !== null) {
        references.push({
          index: node.start ?? 0,
          kind: 'require',
          moduleName,
          specifiers: [],
        });
      }
      return;
    }
    if (node.type === 'TSImportType') {
      const moduleName = moduleReferenceValue(node.argument);
      if (moduleName !== null) {
        references.push({
          index: node.start ?? 0,
          kind: 'type-import',
          moduleName,
          specifiers: [],
        });
      }
      return;
    }
    if (node.type === 'TSExternalModuleReference') {
      const moduleName = moduleReferenceValue(node.expression);
      if (moduleName !== null) {
        references.push({
          index: node.start ?? 0,
          kind: 'require',
          moduleName,
          specifiers: [],
        });
      }
    }
  });
  return references;
}

function scanSourceFile(text, relativePath) {
  const violations = [];
  const importedSymbols = [];
  let routerImportCount = 0;

  if (ROUTER_CONFIG_FILE_PATTERN.test(relativePath)) {
    violations.push(
      violation('source.forbidden-router-api', {
        file: relativePath,
        line: 1,
        rule: 'framework-config-file',
      })
    );
  }

  let moduleReferences;
  try {
    moduleReferences = findModuleReferences(text, relativePath);
  } catch {
    violations.push(
      violation('source.parse-failed', {
        file: relativePath,
      })
    );
    return { importedSymbols, routerImportCount, violations };
  }
  for (const sourceImport of moduleReferences.filter(
    ({ kind, moduleName }) =>
      kind === 'static' && ROUTER_MODULE_PATTERN.test(moduleName)
  )) {
    routerImportCount += 1;
    const { moduleName } = sourceImport;
    const line = lineForIndex(text, sourceImport.index);
    if (moduleName !== 'react-router-dom') {
      violations.push(
        violation('source.forbidden-router-module', {
          file: relativePath,
          line,
          rule: 'direct-or-internal-router-import',
        })
      );
      continue;
    }
    const names = parseNamedImports(sourceImport.specifiers);
    if (!names || names.length === 0) {
      violations.push(
        violation('source.invalid-router-import-shape', {
          file: relativePath,
          line,
        })
      );
      continue;
    }
    for (const name of names) {
      importedSymbols.push(name);
      if (!ALLOWED_ROUTER_DOM_IMPORTS.has(name)) {
        violations.push(
          violation('source.forbidden-router-api', {
            file: relativePath,
            line,
            rule: 'non-declarative-router-import',
          })
        );
      }
    }
  }

  for (const sourceImport of moduleReferences.filter(
    ({ kind, moduleName }) =>
      kind !== 'static' && ROUTER_MODULE_PATTERN.test(moduleName)
  )) {
    routerImportCount += 1;
    violations.push(
      violation('source.forbidden-router-module', {
        file: relativePath,
        line: lineForIndex(text, sourceImport.index),
        rule: 'side-effect-dynamic-require-or-reexport',
      })
    );
  }

  for (const sourceImport of moduleReferences.filter(
    ({ kind, moduleName }) =>
      kind === 'static' && /^react-dom(?:\/.*)?$/.test(moduleName)
  )) {
    const { moduleName } = sourceImport;
    const line = lineForIndex(text, sourceImport.index);
    const allowedNames = ALLOWED_REACT_DOM_IMPORTS.get(moduleName);
    if (!allowedNames) {
      violations.push(
        violation('source.forbidden-react-dom-module', {
          file: relativePath,
          line,
          rule: moduleName.startsWith('react-dom/server')
            ? 'ssr-react-dom-module'
            : 'unapproved-react-dom-module',
        })
      );
      continue;
    }
    const names = parseNamedImports(sourceImport.specifiers);
    if (!names || names.length === 0) {
      violations.push(
        violation('source.invalid-react-dom-import-shape', {
          file: relativePath,
          line,
        })
      );
      continue;
    }
    for (const name of names) {
      if (!allowedNames.has(name)) {
        violations.push(
          violation('source.forbidden-rendering-api', {
            file: relativePath,
            line,
            rule: name === 'hydrateRoot'
              ? 'hydration-api'
              : 'unapproved-react-dom-api',
          })
        );
      }
    }
  }

  for (const sourceImport of moduleReferences.filter(
    ({ kind, moduleName }) =>
      kind !== 'static' && /^react-dom(?:\/.*)?$/.test(moduleName)
  )) {
    violations.push(
      violation('source.forbidden-react-dom-module', {
        file: relativePath,
        line: lineForIndex(text, sourceImport.index),
        rule: sourceImport.moduleName.startsWith('react-dom/server')
          ? 'ssr-react-dom-module'
          : 'dynamic-require-reexport-or-side-effect-react-dom',
      })
    );
  }

  for (const group of FORBIDDEN_SOURCE_API_GROUPS) {
    for (const token of group.tokens) {
      const expression = new RegExp(`\\b${token}\\b`, 'g');
      for (const match of text.matchAll(expression)) {
        violations.push(
          violation(group.code ?? 'source.forbidden-router-api', {
            file: relativePath,
            line: lineForIndex(text, match.index ?? 0),
            rule: group.rule,
          })
        );
      }
    }
  }

  for (const policy of FORBIDDEN_SOURCE_PATTERNS) {
    for (const match of text.matchAll(policy.expression)) {
      violations.push(
        violation(policy.code ?? 'source.forbidden-router-api', {
          file: relativePath,
          line: lineForIndex(text, match.index ?? 0),
          rule: policy.rule,
        })
      );
    }
  }

  return { importedSymbols, routerImportCount, violations };
}

async function scanSources(projectRoot, sourceRoot, violations) {
  let files;
  try {
    const expectedSourceRoot = path.join(projectRoot, 'src');
    if (path.resolve(sourceRoot) !== path.resolve(expectedSourceRoot)) {
      throw new Error('source-root-not-project-src');
    }
    const sourceInfo = await lstat(sourceRoot);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new Error('invalid-source-root');
    }
    files = await collectProjectSourceFiles(projectRoot);
  } catch {
    violations.push(violation('source.root-invalid'));
    return {
      sourceFileCount: 0,
      sourceTreeSha256: null,
      routerImportCount: 0,
      importedSymbols: [],
    };
  }
  if (files.length === 0) {
    violations.push(violation('source.files-missing'));
    return {
      sourceFileCount: 0,
      sourceTreeSha256: null,
      routerImportCount: 0,
      importedSymbols: [],
    };
  }

  const importedSymbols = [];
  let routerImportCount = 0;
  for (const file of files) {
    if (PROJECT_HASH_ONLY_FILES.has(file.relativePath)) {
      continue;
    }
    const text = await readFile(file.absolutePath, 'utf8');
    const result = scanSourceFile(text, file.relativePath);
    importedSymbols.push(...result.importedSymbols);
    routerImportCount += result.routerImportCount;
    violations.push(...result.violations);
  }

  const imported = new Set(importedSymbols);
  for (const symbol of REQUIRED_DECLARATIVE_SURFACE) {
    if (!imported.has(symbol)) {
      violations.push(
        violation('source.required-declarative-api-missing', {
          rule: symbol,
        })
      );
    }
  }
  if (routerImportCount === 0) {
    violations.push(violation('source.router-imports-missing'));
  }

  return {
    importedSymbols: [...imported].sort(),
    routerImportCount,
    sourceFileCount: files.length,
    sourceTreeSha256: await hashTree(files),
  };
}

async function scanBundle(distRoot, violations) {
  let files;
  try {
    files = await collectFiles(distRoot);
  } catch {
    violations.push(violation('bundle.root-invalid'));
    return { bundleFileCount: 0, bundleTreeSha256: null };
  }
  if (files.length === 0) {
    violations.push(violation('bundle.files-missing'));
    return { bundleFileCount: 0, bundleTreeSha256: null };
  }

  const indexEntry = files.find((file) => file.relativePath === 'index.html');
  const scriptEntries = files.filter((file) =>
    ['.js', '.mjs', '.cjs'].includes(
      path.extname(file.relativePath).toLowerCase()
    )
  );
  if (!indexEntry) violations.push(violation('bundle.index-missing'));
  if (scriptEntries.length === 0) {
    violations.push(violation('bundle.scripts-missing'));
  }

  for (const file of files) {
    if (!TEXT_BUNDLE_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase())) {
      continue;
    }
    const text = await readFile(file.absolutePath, 'utf8');
    for (const group of FORBIDDEN_BUNDLE_TOKEN_GROUPS) {
      for (const token of group.tokens) {
        let index = text.indexOf(token);
        while (index !== -1) {
          violations.push(
            violation('bundle.forbidden-router-token', {
              file: file.relativePath,
              line: lineForIndex(text, index),
              rule: group.rule,
            })
          );
          index = text.indexOf(token, index + token.length);
        }
      }
    }
  }

  return {
    bundleFileCount: files.length,
    bundleTreeSha256: await hashTree(files),
  };
}

function sortViolations(violations) {
  return violations
    .map((entry) => ({
      code: entry.code,
      ...(entry.file ? { file: entry.file } : {}),
      ...(Number.isInteger(entry.line) ? { line: entry.line } : {}),
      ...(entry.rule ? { rule: entry.rule } : {}),
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

export async function evaluateRouterReachability({
  packageJsonPath,
  packageLockPath,
  dispositionPath,
  sourceRoot,
  distRoot = null,
  mode,
  variant,
  now = new Date(),
}) {
  const violations = [];
  if (!VALID_MODES.has(mode)) violations.push(violation('input.mode-invalid'));
  if (!VALID_VARIANTS.has(variant)) {
    violations.push(violation('input.variant-invalid'));
  }
  if (mode === 'post-build' && !distRoot) {
    violations.push(violation('input.dist-root-missing'));
  }
  const projectRoot = path.dirname(path.resolve(packageJsonPath));

  const packageResult = await readJsonFile(
    packageJsonPath,
    'input.package-json-missing',
    violations
  );
  const lockResult = await readJsonFile(
    packageLockPath,
    'input.package-lock-missing',
    violations
  );
  const dispositionResult = await readJsonFile(
    dispositionPath,
    'input.disposition-missing',
    violations
  );

  const packageLockSha256 = lockResult.bytes
    ? sha256(lockResult.bytes)
    : null;
  const dispositionSha256 = dispositionResult.bytes
    ? sha256(dispositionResult.bytes)
    : null;
  const identity = validatePackageIdentity({
    packageJson: packageResult.value,
    packageLock: lockResult.value,
    disposition: dispositionResult.value,
    packageLockSha256,
    dispositionSha256,
    now,
    violations,
  });

  const source = await scanSources(projectRoot, sourceRoot, violations);
  let bundle = { bundleFileCount: 0, bundleTreeSha256: null };
  if (mode === 'post-build' && distRoot) {
    bundle = await scanBundle(distRoot, violations);
  }

  const sortedViolations = sortViolations(violations);
  const passed = sortedViolations.length === 0;
  return {
    schemaVersion: ROUTER_REACHABILITY_EVIDENCE_VERSION,
    mode,
    variant,
    status: passed ? 'passed' : 'failed',
    passed,
    dispositionSha256: identity.dispositionSha256,
    packageLockSha256: identity.packageLockSha256,
    routerVersion: identity.routerVersion,
    routerDomVersion: identity.routerDomVersion,
    sourceTreeSha256: source.sourceTreeSha256,
    bundleTreeSha256: bundle.bundleTreeSha256,
    sourceFileCount: source.sourceFileCount,
    routerImportCount: source.routerImportCount,
    bundleFileCount: bundle.bundleFileCount,
    violations: sortedViolations,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error('invalid-arguments');
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || values.has(key)) {
      throw new Error('invalid-arguments');
    }
    values.set(key, value);
    index += 1;
  }
  const required = [
    'package-json',
    'package-lock',
    'disposition',
    'source-root',
    'mode',
    'variant',
    'output',
  ];
  for (const key of required) {
    if (!values.has(key)) throw new Error('invalid-arguments');
  }
  if (values.get('mode') === 'post-build' && !values.has('dist-root')) {
    throw new Error('invalid-arguments');
  }
  const allowed = new Set([...required, 'dist-root']);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error('invalid-arguments');
  }
  return {
    packageJsonPath: values.get('package-json'),
    packageLockPath: values.get('package-lock'),
    dispositionPath: values.get('disposition'),
    sourceRoot: values.get('source-root'),
    mode: values.get('mode'),
    variant: values.get('variant'),
    outputPath: values.get('output'),
    distRoot: values.get('dist-root') ?? null,
  };
}

async function writeEvidence(outputPath, evidence) {
  const parent = path.dirname(outputPath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, `${canonicalJson(evidence)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function runRouterReachabilityCli(argv, { now = new Date() } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch {
    process.stderr.write('frontend_router_reachability_invalid_arguments\n');
    return 2;
  }

  let evidence;
  try {
    evidence = await evaluateRouterReachability({
      ...parsed,
      now,
    });
  } catch {
    evidence = {
      schemaVersion: ROUTER_REACHABILITY_EVIDENCE_VERSION,
      mode: parsed.mode,
      variant: parsed.variant,
      status: 'failed',
      passed: false,
      dispositionSha256: null,
      packageLockSha256: null,
      routerVersion: null,
      routerDomVersion: null,
      sourceTreeSha256: null,
      bundleTreeSha256: null,
      sourceFileCount: 0,
      routerImportCount: 0,
      bundleFileCount: 0,
      violations: [{ code: 'checker.runtime-failure' }],
    };
  }

  try {
    await writeEvidence(parsed.outputPath, evidence);
  } catch {
    process.stderr.write('frontend_router_reachability_evidence_write_failed\n');
    return 2;
  }

  process.stdout.write(
    `frontend_router_reachability_${evidence.passed ? 'passed' : 'failed'}\n`
  );
  return evidence.passed ? 0 : 1;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await runRouterReachabilityCli(process.argv.slice(2));
}
