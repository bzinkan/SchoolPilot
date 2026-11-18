import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendAppDomains, appLibraryKey, appPreferenceChange, appScopeDescription, visibleApps } from '../src/products/classpilot/lib/appLibrary.js';
import { teachingToolsQuery } from '../src/products/classpilot/lib/teachingTools.js';
import { legacyAdminQuery } from '../src/products/classpilot/lib/adminNavigation.js';

const apps = [
  { key: 'builtin:bundle', name: 'Google Classroom bundle', source: 'common', kind: 'bundle', saved: false, favorite: false },
  { key: 'builtin:ixl', name: 'IXL', source: 'common', kind: 'app', saved: true, favorite: false, launchUrl: 'https://www.ixl.com/' },
  { key: 'saved:school', name: 'School learning', source: 'school', kind: 'app', saved: false, favorite: true, launchUrl: 'https://school.example.org/' },
  { key: 'saved:personal', name: 'My reading', source: 'personal', kind: 'app', saved: true, favorite: false, launchUrl: 'https://reading.example.org/' },
];

test('app library cache identity includes both school and viewer', () => {
  assert.deepEqual(appLibraryKey('school-a', 'teacher-a'), ['/api/classpilot/apps', 'school-a', 'teacher-a']);
  assert.notDeepEqual(appLibraryKey('school-a', 'teacher-a'), appLibraryKey('school-b', 'teacher-a'));
  assert.notDeepEqual(appLibraryKey('school-a', 'teacher-a'), appLibraryKey('school-a', 'teacher-b'));
  assert.equal(teachingToolsQuery({ queryKey: appLibraryKey('school-a', 'teacher-a') }), true);
  assert.equal(legacyAdminQuery({ queryKey: appLibraryKey('school-a', 'teacher-a') }), true);
});

test('search and source filters preserve favorites first and hide bundles for URL actions', () => {
  assert.deepEqual(visibleApps(apps, { mode: 'url' }).map(app => app.key), ['saved:school', 'builtin:ixl', 'saved:personal']);
  assert.deepEqual(visibleApps(apps, { filter: 'my' }).map(app => app.key), ['builtin:ixl', 'saved:personal']);
  assert.deepEqual(visibleApps(apps, { filter: 'common', mode: 'flight-path' }).map(app => app.key), ['builtin:bundle', 'builtin:ixl']);
  assert.deepEqual(visibleApps(apps, { search: 'READING.EXAMPLE' }).map(app => app.key), ['saved:personal']);
});

test('adding overlapping apps deduplicates domains without deleting manual entries', () => {
  assert.equal(appendAppDomains('WWW.Example.org, docs.google.com, not valid yet', ['docs.google.com', 'drive.google.com', 'classroom.google.com', 'drive.google.com']),
    'WWW.Example.org, docs.google.com, not valid yet, drive.google.com, classroom.google.com');
  assert.equal(appendAppDomains('https://www.ixl.com/lesson', ['ixl.com', 'quill.org']), 'https://www.ixl.com/lesson, quill.org');
});

test('scope copy exposes shared Google website access without implying Docs-only filtering', () => {
  assert.match(appScopeDescription({ allowedDomains: ['docs.google.com'] }), /Docs, Slides, Sheets, and Forms/);
  assert.match(appScopeDescription({ allowedDomains: ['classroom.google.com', 'docs.google.com', 'drive.google.com'] }), /drive.google.com/);
});

test('favorite and saved interactions always obey favorite implies saved', () => {
  assert.deepEqual(appPreferenceChange({ saved: false, favorite: false }, 'favorite'), { saved: true, favorite: true });
  assert.deepEqual(appPreferenceChange({ saved: true, favorite: true }, 'saved'), { saved: false, favorite: false });
  assert.deepEqual(appPreferenceChange({ saved: true, favorite: true }, 'favorite'), { saved: true, favorite: false });
});

test('scope descriptions project effective Classroom websites without changing authoring domains', () => {
  const allowedDomains = ['classroom.google.com'];
  const value = { allowedDomains, effectiveAllowedDomains: ['classroom.google.com', 'docs.google.com', 'drive.google.com', 'forms.gle'] };
  assert.match(appScopeDescription(value), /forms.gle/);
  assert.match(appScopeDescription(value), /applied by.*Classroom/i);
  assert.deepEqual(allowedDomains, ['classroom.google.com']);
});
