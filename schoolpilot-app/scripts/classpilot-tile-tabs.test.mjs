import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TILE_FAVICON_MAX,
  deriveTileTabFavicons,
  safeFaviconUrl,
} from '../src/products/classpilot/lib/tileTabFavicons.js';

function tab(index, overrides = {}) {
  return {
    tabRef: `tab-${index}`,
    url: `https://site-${index}.example.test/page`,
    title: `Site ${index}`,
    favicon: `https://site-${index}.example.test/favicon.ico`,
    ...overrides,
  };
}

test('favicon URLs are https-only and bounded in length', () => {
  assert.equal(safeFaviconUrl('https://cdn.example.test/favicon.ico'), 'https://cdn.example.test/favicon.ico');
  assert.equal(safeFaviconUrl('  https://cdn.example.test/favicon.ico  '), 'https://cdn.example.test/favicon.ico');
  assert.equal(safeFaviconUrl('http://cdn.example.test/favicon.ico'), null, 'plain http must not become an <img>');
  assert.equal(safeFaviconUrl('data:image/png;base64,AAAA'), null, 'data URLs must not become an <img>');
  assert.equal(safeFaviconUrl('javascript:alert(1)'), null);
  assert.equal(safeFaviconUrl('chrome://favicon/https://x'), null);
  assert.equal(safeFaviconUrl('not a url'), null);
  assert.equal(safeFaviconUrl(''), null);
  assert.equal(safeFaviconUrl(null), null);
  assert.equal(safeFaviconUrl(42), null);
  assert.equal(safeFaviconUrl(`https://cdn.example.test/${'a'.repeat(2048)}`), null, 'over-long URLs are dropped');
});

test('chrome:// and non-http(s) tabs are dropped from the strip', () => {
  const projection = deriveTileTabFavicons({
    studentId: 'student-1',
    allOpenTabs: [
      tab(1),
      { tabRef: 'tab-ext', url: 'chrome://extensions', title: 'Extensions', favicon: 'https://x.example.test/f.ico' },
      { tabRef: 'tab-file', url: 'file:///C:/notes.txt', title: 'Notes' },
      { tabRef: 'tab-about', url: 'about:blank', title: 'Blank' },
      { tabRef: 'tab-bad', url: 'not a url', title: 'Broken' },
      { tabRef: 'tab-empty', url: '', title: 'Empty' },
      tab(2),
    ],
  });
  assert.deepEqual(projection.tabs.map((entry) => entry.hostname), [
    'site-1.example.test',
    'site-2.example.test',
  ]);
  assert.equal(projection.totalCount, 7, 'without openTabCount the raw snapshot length is the total');
  assert.equal(projection.shownCount, 2);
  assert.equal(projection.overflow, 5);
});

test('rejected favicons render as placeholders rather than being dropped', () => {
  const projection = deriveTileTabFavicons({
    allOpenTabs: [
      tab(1, { favicon: 'http://site-1.example.test/favicon.ico' }),
      tab(2, { favicon: 'data:image/png;base64,AAAA' }),
      tab(3, { favicon: undefined }),
      tab(4),
    ],
  });
  assert.deepEqual(projection.tabs.map((entry) => entry.favicon), [
    null,
    null,
    null,
    'https://site-4.example.test/favicon.ico',
  ]);
  assert.equal(projection.shownCount, 4);
});

test('tabs are deduplicated by hostname and the active tab wins the chip', () => {
  const projection = deriveTileTabFavicons({
    activeTabRef: 'tab-b',
    activeTabUrl: 'https://reading.example.test/chapter-2',
    allOpenTabs: [
      { tabRef: 'tab-a', url: 'https://reading.example.test/chapter-1', title: 'Chapter 1', favicon: 'https://reading.example.test/a.ico' },
      { tabRef: 'tab-b', url: 'https://reading.example.test/chapter-2', title: 'Chapter 2', favicon: 'https://reading.example.test/b.ico' },
      { tabRef: 'tab-c', url: 'https://READING.example.test/chapter-3', title: 'Chapter 3' },
      { tabRef: 'tab-d', url: 'https://other.example.test/', title: 'Other' },
    ],
  });
  assert.equal(projection.tabs.length, 2);
  assert.deepEqual(projection.tabs[0], {
    key: 'tab-b',
    hostname: 'reading.example.test',
    title: 'Chapter 2',
    favicon: 'https://reading.example.test/b.ico',
    active: true,
  });
  assert.deepEqual(projection.tabs[1], {
    key: 'tab-d',
    hostname: 'other.example.test',
    title: 'Other',
    favicon: null,
    active: false,
  });
});

test('the active tab is ordered first by tabRef, or by URL for legacy snapshots', () => {
  const byRef = deriveTileTabFavicons({
    activeTabRef: 'tab-3',
    activeTabUrl: 'https://site-3.example.test/page',
    allOpenTabs: [tab(1), tab(2), tab(3), tab(4)],
  });
  assert.deepEqual(byRef.tabs.map((entry) => entry.key), ['tab-3', 'tab-1', 'tab-2', 'tab-4']);
  assert.deepEqual(byRef.tabs.map((entry) => entry.active), [true, false, false, false]);

  const byUrl = deriveTileTabFavicons({
    activeTabUrl: 'https://site-2.example.test/page',
    allOpenTabs: [
      tab(1, { tabRef: undefined }),
      tab(2, { tabRef: undefined }),
      tab(3, { tabRef: undefined }),
    ],
  });
  assert.deepEqual(byUrl.tabs.map((entry) => entry.key), [
    'https://site-2.example.test/page',
    'https://site-1.example.test/page',
    'https://site-3.example.test/page',
  ]);
  assert.equal(byUrl.tabs[0].active, true);

  const noActiveRef = deriveTileTabFavicons({
    allOpenTabs: [tab(1, { tabRef: undefined }), tab(2, { tabRef: undefined })],
  });
  assert.deepEqual(
    noActiveRef.tabs.map((entry) => entry.active),
    [false, false],
    'undefined tabRef must never equal an undefined activeTabRef',
  );
});

test('overflow derives from the server openTabCount and respects the strip maximum', () => {
  const tabs = Array.from({ length: 12 }, (_, index) => tab(index + 1));
  const projection = deriveTileTabFavicons({ openTabCount: 15, allOpenTabs: tabs });
  assert.equal(TILE_FAVICON_MAX, 8);
  assert.equal(projection.shownCount, 8);
  assert.equal(projection.tabs.length, 8);
  assert.equal(projection.totalCount, 15);
  assert.equal(projection.overflow, 7);
  assert.equal(projection.truncated, false);

  const smaller = deriveTileTabFavicons({ openTabCount: 15, allOpenTabs: tabs }, { max: 3 });
  assert.equal(smaller.shownCount, 3);
  assert.equal(smaller.overflow, 12);

  const fewer = deriveTileTabFavicons({ openTabCount: 2, allOpenTabs: tabs.slice(0, 2) });
  assert.equal(fewer.overflow, 0);

  const staleCount = deriveTileTabFavicons({ openTabCount: 1, allOpenTabs: tabs.slice(0, 4) });
  assert.equal(staleCount.overflow, 0, 'overflow never goes negative when the count lags the snapshot');
});

test('truncated snapshots are flagged and empty students project safely', () => {
  const truncated = deriveTileTabFavicons({ openTabCount: 40, tabsTruncated: true, allOpenTabs: [tab(1)] });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.overflow, 39);

  assert.deepEqual(deriveTileTabFavicons({ tabsTruncated: 'yes' }).truncated, false);
  assert.deepEqual(deriveTileTabFavicons(null), {
    tabs: [],
    shownCount: 0,
    totalCount: 0,
    overflow: 0,
    truncated: false,
  });
  assert.deepEqual(deriveTileTabFavicons({ allOpenTabs: 'not-an-array', openTabCount: 'three' }).tabs, []);
});
