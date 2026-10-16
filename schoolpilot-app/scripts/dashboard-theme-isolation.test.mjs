import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/CLASSPILOT_DASHBOARD_THEMES.md §4.10: a theme is presentation only. The
// only code allowed to read it is listed here; realtime, commands, sockets,
// schedulers and the extension contract never import it. Add a file to a list
// on purpose, with a reason in the PR, not because the build told you to.

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const rel = file => path.relative(src, file).split(path.sep).join('/');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(src).map(file => ({ file: rel(file), text: readFileSync(file, 'utf8') }));
const using = pattern => files.filter(({ text }) => pattern.test(text)).map(({ file }) => file).sort();

const ALLOW = {
  'shared/themes imports': {
    pattern: /from ['"][^'"]*shared\/themes\//,
    files: [
      'products/classpilot/components/DashboardThemeCard.jsx',
      'products/classpilot/components/DashboardThemeMenu.jsx',
      'products/classpilot/hooks/useDashboardTheme.js',
      'products/classpilot/pages/Settings.jsx',
      'products/passpilot/components/KioskNamePlate.jsx',
      'products/passpilot/pages/Kiosk.jsx',
      'products/passpilot/pages/KioskSimple.jsx',
      'products/passpilot/useKioskTheme.js',
    ],
  },
  'useDashboardTheme callers': {
    pattern: /useDashboardTheme\(/,
    files: [
      'products/classpilot/components/admin/AdminDashboardThemeMenu.jsx',
      'products/classpilot/hooks/useDashboardTheme.js',
      'products/classpilot/pages/Dashboard.jsx',
    ],
  },
  'dashboard theme attribute': {
    pattern: /data-theme=/,
    files: ['products/classpilot/dashboardThemes.css', 'products/classpilot/pages/Dashboard.jsx'],
  },
  'theme context readers': {
    pattern: /DashboardThemeContext|useActiveDashboardTheme/,
    files: [
      'products/classpilot/components/TileOrnament.jsx',
      'products/classpilot/contexts/DashboardThemeContext.jsx',
      'products/classpilot/pages/Dashboard.jsx',
    ],
  },
  'kiosk theme': {
    pattern: /useKioskTheme\(|data-kiosk-theme/,
    files: [
      'products/passpilot/kioskTheme.css',
      'products/passpilot/pages/Kiosk.jsx',
      'products/passpilot/pages/KioskSimple.jsx',
      'products/passpilot/useKioskTheme.js',
    ],
  },
};

for (const [name, { pattern, files: allowed }] of Object.entries(ALLOW)) {
  test(`theme isolation: ${name} stay inside the allowlist`, () => {
    assert.deepEqual(using(pattern), [...allowed].sort());
  });
}

test('theme isolation: realtime, command, socket and extension code never reads a theme', () => {
  const guarded = files.filter(({ file }) => /(realtime|commands?|socket|websocket|extension|heartbeat|scheduler)/i.test(file));
  assert.ok(guarded.length > 0, 'the guarded directories exist');
  const offenders = guarded.filter(({ text }) => /shared\/themes\/|useDashboardTheme|useKioskTheme|data-theme=|data-kiosk-theme|DashboardThemeContext/.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});
