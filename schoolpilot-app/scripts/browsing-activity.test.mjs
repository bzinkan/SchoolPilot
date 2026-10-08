import assert from 'node:assert/strict';
import test from 'node:test';
import { getBrowsingActivityTitle } from '../src/lib/browsing-activity.js';
import { calculateURLSessions } from '../src/lib/classpilot-utils.js';

test('preserves meaningful reported titles without guessing new sentinel values', () => {
  for (const title of ['Photosynthesis - Google Search', 'Untitled document', 'Unknown artist', 'New Tab', 'Loading...', 'N/A']) {
    assert.equal(getBrowsingActivityTitle(title, 'https://www.google.com/search?q=plants'), title);
    assert.equal(getBrowsingActivityTitle(title, null), title);
  }
  assert.equal(getBrowsingActivityTitle('  Biology notes  ', 'https://docs.google.com/document/d/example/edit'), 'Biology notes');
});

test('improves both missing titles and existing Unknown records using the recorded URL', () => {
  for (const title of [null, undefined, '', '   ', 'Unknown', 'UNKNOWN', ' unknown ']) {
    assert.equal(getBrowsingActivityTitle(title, 'https://www.google.com/search?q=photosynthesis'), 'Google search: photosynthesis');
  }
});

test('consecutive retained Unknown observations keep a descriptive browsing-session title', () => {
  const heartbeats = [0, 10, 20].map((second) => ({
    timestamp: new Date(Date.UTC(2026, 9, 8, 14, 0, second)).toISOString(),
    activeTabTitle: 'Unknown',
    activeTabUrl: 'https://www.google.com/search?q=plant+cells',
  }));
  const sessions = calculateURLSessions(heartbeats);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'Google search: plant cells');
  assert.equal(sessions[0].url, heartbeats[0].activeTabUrl);
  assert.equal(sessions[0].heartbeatCount, 3);
  assert.equal(sessions[0].durationSeconds, 30);
});

test('browsing sessions with no recorded title or URL explain that page details are unavailable', () => {
  const sessions = calculateURLSessions([
    { timestamp: '2026-10-08T14:00:00Z', activeTabTitle: null, activeTabUrl: null },
    { timestamp: '2026-10-08T14:00:10Z', activeTabTitle: 'Unknown', activeTabUrl: null },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'Page details unavailable');
  assert.equal(sessions[0].heartbeatCount, 2);
});

test('decodes URL search terms once and normalizes spacing and invisible controls', () => {
  assert.equal(getBrowsingActivityTitle('', 'https://google.com/search?q=plant+cells%20%26%20energy'), 'Google search: plant cells & energy');
  assert.equal(getBrowsingActivityTitle('', 'https://www.google.ca/search/?q=%20caf%C3%A9%09%0Aplants%00%20%20%20%E2%80%AEbiology'), 'Google search: café plants biology');
  assert.equal(getBrowsingActivityTitle('', 'https://google.com/search?q=100%2525'), 'Google search: 100%25');
  assert.equal(getBrowsingActivityTitle('', 'https://google.com/search?q=%20%00'), 'Google search results');
  assert.equal(getBrowsingActivityTitle('', 'https://google.com/search'), 'Google search results');
});

test('bounds long query labels without splitting a Unicode character', () => {
  const label = getBrowsingActivityTitle('Unknown', `https://www.google.com/search?q=${encodeURIComponent('🌱'.repeat(200))}`);
  const query = label.slice('Google search: '.length);
  assert.equal(Array.from(query).length, 120);
  assert.equal(query, `${'🌱'.repeat(119)}…`);
});

test('requires a recognized search host and search page before describing a query', () => {
  for (const [url, expected] of [
    ['https://google.com.evil.test/search?q=biology', 'google.com.evil.test'],
    ['https://www.google.com@evil.test/search?q=biology', 'evil.test'],
    ['https://notgoogle.com/search?q=biology', 'notgoogle.com'],
    ['https://docs.google.com/search?q=biology', 'Google Docs'],
    ['https://google.com/url?q=biology', 'google.com'],
    ['https://google.com/searching?q=biology', 'google.com'],
    ['https://google.com/search/other?q=biology', 'google.com'],
    ['https://google.com/?q=biology', 'google.com'],
    ['https://google.com/#q=biology', 'google.com'],
    ['https://example.test/search?q=biology', 'example.test'],
  ]) assert.equal(getBrowsingActivityTitle('Unknown', url), expected, url);
});

test('names Google school apps and documents without claiming editing activity', () => {
  for (const [url, expected] of [
    ['https://docs.google.com/document/d/example/edit', 'Google Docs document'],
    ['https://docs.google.com/document/u/1/d/example/view', 'Google Docs document'],
    ['https://docs.google.com/spreadsheets/d/example/edit#gid=0', 'Google Sheets spreadsheet'],
    ['https://docs.google.com/presentation/d/example/present', 'Google Slides presentation'],
    ['https://docs.google.com/document/u/0/', 'Google Docs'],
    ['https://docs.google.com/spreadsheets/', 'Google Sheets'],
    ['https://docs.google.com/presentation/', 'Google Slides'],
    ['https://docs.google.com/document/d/', 'Google Docs'],
    ['https://docs.google.com/documentary/d/example', 'Google Docs'],
    ['https://classroom.google.com/c/example/a/example', 'Google Classroom'],
    ['https://drive.google.com/drive/u/0/my-drive', 'Google Drive'],
    ['https://docs.google.com.evil.test/document/d/example/edit', 'docs.google.com.evil.test'],
    ['https://classroom.google.com.evil.test/', 'classroom.google.com.evil.test'],
  ]) assert.equal(getBrowsingActivityTitle('Unknown', url), expected, url);
});

test('describes YouTube search and video pages without claiming playback', () => {
  for (const [url, expected] of [
    ['https://www.youtube.com/results?search_query=cell+division', 'YouTube search: cell division'],
    ['https://m.youtube.com/results?search_query=', 'YouTube search results'],
    ['https://www.youtube.com/watch?v=example', 'YouTube video page'],
    ['https://youtube.com/shorts/example', 'YouTube video page'],
    ['https://youtu.be/example?t=10', 'YouTube video page'],
    ['https://www.youtube.com/watch', 'YouTube'],
    ['https://www.youtube.com/results/other?search_query=biology', 'YouTube'],
    ['https://youtube.com.evil.test/watch?v=example', 'youtube.com.evil.test'],
  ]) assert.equal(getBrowsingActivityTitle('', url), expected, url);
});

test('describes other recognized searches and leaves unrelated query parameters alone', () => {
  assert.equal(getBrowsingActivityTitle('', 'https://www.bing.com/search?q=water+cycle'), 'Bing search: water cycle');
  assert.equal(getBrowsingActivityTitle('', 'https://duckduckgo.com/?q=water+cycle'), 'DuckDuckGo search: water cycle');
  assert.equal(getBrowsingActivityTitle('', 'https://bing.com/images?q=water+cycle'), 'bing.com');
  assert.equal(getBrowsingActivityTitle('', 'https://duckduckgo.com/about?q=water+cycle'), 'duckduckgo.com');
});

test('uses website names without exposing URL credentials, query strings, or fragments', () => {
  assert.equal(getBrowsingActivityTitle(null, 'https://www.khanacademy.org/math/lesson?token=example#section'), 'khanacademy.org');
  assert.equal(getBrowsingActivityTitle(null, 'http://name:password@example.test:8080/lesson'), 'example.test');
});

test('identifies Chrome pages and blank pages separately from unavailable information', () => {
  for (const [url, expected] of [
    ['chrome://newtab/', 'New tab'],
    ['chrome-search://local-ntp/local-ntp.html', 'New tab'],
    ['about:blank', 'Blank page'],
    ['chrome://history/', 'Chrome history'],
    ['chrome://downloads/', 'Chrome downloads'],
    ['chrome://settings/privacy', 'Chrome settings'],
    ['chrome://extensions/', 'Chrome extensions'],
    ['chrome://version/', 'Chrome internal page'],
  ]) assert.equal(getBrowsingActivityTitle('Unknown', url), expected, url);
});

test('missing, malformed, and unsupported URL data stays explicitly unavailable', () => {
  for (const url of [null, undefined, '', '   ', {}, 42, 'not a URL', 'www.google.com/search?q=plants',
    'https://', 'javascript:alert(1)', 'data:text/html,example', 'file:///C:/report.pdf',
    'chrome-extension://example/page.html', 'about:unknown', 'chrome-search://unknown/page']) {
    assert.equal(getBrowsingActivityTitle('Unknown', url), 'Page details unavailable');
  }
});
