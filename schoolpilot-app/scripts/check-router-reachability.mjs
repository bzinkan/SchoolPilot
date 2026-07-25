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

function parseNamedImports(tokens) {
  const specifierTokens = [...tokens];
  if (specifierTokens[0]?.value === 'type') specifierTokens.shift();
  if (
    specifierTokens[0]?.value !== '{' ||
    specifierTokens.at(-1)?.value !== '}'
  ) {
    return null;
  }
  const body = specifierTokens.slice(1, -1);
  const names = [];
  let part = [];
  for (let index = 0; index <= body.length; index += 1) {
    const token = body[index];
    if (token?.value !== ',' && index < body.length) {
      part.push(token);
      continue;
    }
    if (part.length === 0) continue;
    if (part[0]?.value === 'type') part = part.slice(1);
    if (
      part.length !== 1 &&
      !(
        part.length === 3 &&
        part[1]?.value === 'as' &&
        part[2]?.type === 'identifier'
      )
    ) {
      return null;
    }
    const importedName = part[0]?.value;
    if (
      part[0]?.type !== 'identifier' ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(importedName ?? '')
    ) {
      return null;
    }
    names.push(importedName);
    part = [];
  }
  return names;
}

function isIdentifierStart(character) {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character) {
  return /[A-Za-z0-9_$]/.test(character);
}

function readStringToken(text, start) {
  const quote = text[start];
  let value = '';
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === quote) {
      return {
        end: index + 1,
        token: { type: 'string', value, index: start },
      };
    }
    if (character !== '\\') {
      if (character === '\r' || character === '\n') return null;
      value += character;
      continue;
    }

    index += 1;
    if (index >= text.length) return null;
    const escaped = text[index];
    if (escaped === '\r' || escaped === '\n') {
      if (escaped === '\r' && text[index + 1] === '\n') index += 1;
      continue;
    }
    const simpleEscapes = new Map([
      ['b', '\b'],
      ['f', '\f'],
      ['n', '\n'],
      ['r', '\r'],
      ['t', '\t'],
      ['v', '\v'],
      ['0', '\0'],
    ]);
    if (simpleEscapes.has(escaped)) {
      value += simpleEscapes.get(escaped);
      continue;
    }
    if (escaped === 'x') {
      const digits = text.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(digits)) return null;
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      if (text[index + 1] === '{') {
        const close = text.indexOf('}', index + 2);
        const digits = close === -1 ? '' : text.slice(index + 2, close);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) return null;
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint > 0x10ffff) return null;
        value += String.fromCodePoint(codePoint);
        index = close;
        continue;
      }
      const digits = text.slice(index + 1, index + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(digits)) return null;
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      index += 4;
      continue;
    }
    value += escaped;
  }
  return null;
}

function tokenizeJavaScript(text) {
  const tokens = [];

  function scanCode(start, stopAtTemplateExpressionEnd = false) {
    let braceDepth = 0;
    let index = start;
    while (index < text.length) {
      const character = text[index];
      if (/\s/.test(character)) {
        index += 1;
        continue;
      }
      if (character === '/' && text[index + 1] === '/') {
        index += 2;
        while (index < text.length && text[index] !== '\n') index += 1;
        continue;
      }
      if (character === '/' && text[index + 1] === '*') {
        const close = text.indexOf('*/', index + 2);
        index = close === -1 ? text.length : close + 2;
        continue;
      }
      if (character === "'" || character === '"') {
        const result = readStringToken(text, index);
        if (!result) {
          index += 1;
          continue;
        }
        tokens.push(result.token);
        index = result.end;
        continue;
      }
      if (character === '`') {
        index = scanTemplate(index + 1);
        continue;
      }
      if (isIdentifierStart(character)) {
        const identifierStart = index;
        index += 1;
        while (index < text.length && isIdentifierPart(text[index])) {
          index += 1;
        }
        tokens.push({
          type: 'identifier',
          value: text.slice(identifierStart, index),
          index: identifierStart,
        });
        continue;
      }
      if (character === '{') braceDepth += 1;
      if (character === '}') {
        if (stopAtTemplateExpressionEnd && braceDepth === 0) {
          return index + 1;
        }
        braceDepth = Math.max(0, braceDepth - 1);
      }
      tokens.push({ type: 'punctuator', value: character, index });
      index += 1;
    }
    return index;
  }

  function scanTemplate(start) {
    let index = start;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '`') return index + 1;
      if (text[index] === '$' && text[index + 1] === '{') {
        index = scanCode(index + 2, true);
        continue;
      }
      index += 1;
    }
    return index;
  }

  scanCode(0);
  return tokens;
}

function findTopLevelFrom(tokens, start) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (
      value === 'from' &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenthesisDepth === 0 &&
      tokens[index + 1]?.type === 'string'
    ) {
      return index;
    }
    if (
      value === ';' &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenthesisDepth === 0
    ) {
      return -1;
    }
    if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (value === '(') parenthesisDepth += 1;
    else if (value === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    }
  }
  return -1;
}

function findModuleReferences(text) {
  const tokens = tokenizeJavaScript(text);
  const references = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    if (token.value === 'import' && previous?.value !== '.') {
      const next = tokens[index + 1];
      if (next?.type === 'string') {
        references.push({
          index: token.index,
          kind: 'side-effect',
          moduleName: next.value,
          specifierTokens: [],
        });
        continue;
      }
      if (
        next?.value === '(' &&
        tokens[index + 2]?.type === 'string'
      ) {
        references.push({
          index: token.index,
          kind: 'dynamic',
          moduleName: tokens[index + 2].value,
          specifierTokens: [],
        });
        continue;
      }
      if (next?.value === '.') continue;
      const fromIndex = findTopLevelFrom(tokens, index + 1);
      if (fromIndex !== -1) {
        references.push({
          index: token.index,
          kind: 'static',
          moduleName: tokens[fromIndex + 1].value,
          specifierTokens: tokens.slice(index + 1, fromIndex),
        });
      }
      continue;
    }
    if (
      token.value === 'require' &&
      previous?.value !== '.' &&
      tokens[index + 1]?.value === '(' &&
      tokens[index + 2]?.type === 'string'
    ) {
      references.push({
        index: token.index,
        kind: 'require',
        moduleName: tokens[index + 2].value,
        specifierTokens: [],
      });
      continue;
    }
    if (
      token.value === 'export' &&
      (tokens[index + 1]?.value === '{' ||
        tokens[index + 1]?.value === '*' ||
        (tokens[index + 1]?.value === 'type' &&
          tokens[index + 2]?.value === '{'))
    ) {
      const fromIndex = findTopLevelFrom(tokens, index + 1);
      if (fromIndex !== -1) {
        references.push({
          index: token.index,
          kind: 'reexport',
          moduleName: tokens[fromIndex + 1].value,
          specifierTokens: [],
        });
      }
    }
  }
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

  const moduleReferences = findModuleReferences(text);
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
    const names = parseNamedImports(sourceImport.specifierTokens);
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
    const names = parseNamedImports(sourceImport.specifierTokens);
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
