import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL_TITLE = 'Schoolpilot · Teaching';
const ORIGINAL_HREF = '/favicon.svg?theme=day#original-mark';
const ORIGINAL_TYPE = 'image/x-icon';
const entry = `
  import React, { StrictMode, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  const modules = import.meta.glob('/src/products/classpilot/hooks/useClasspilotMessageAlert.js', { eager: true });
  const useMessageAlert = modules['/src/products/classpilot/hooks/useClasspilotMessageAlert.js']?.default || (() => {});
  const h = React.createElement;
  function Alert({ count }) { useMessageAlert(count); return h('output', { 'aria-label': 'Unread messages' }, String(count)); }
  function Harness() {
    const [count, setCount] = useState(0);
    const [scope, setScope] = useState('class-a');
    const [mounted, setMounted] = useState(true);
    return h(React.Fragment, null,
      h('button', { onClick: () => setCount(3) }, 'Receive messages'),
      h('button', { onClick: () => setCount(current => Math.max(0, current - 1)) }, 'Read conversation'),
      h('button', { onClick: () => { setScope('class-b'); setCount(0); } }, 'Change classroom'),
      h('button', { onClick: () => setMounted(false) }, 'Leave classroom'),
      mounted ? h(Alert, { key: scope, count }) : h('p', null, 'Other product'),
    );
  }
  createRoot(document.getElementById('root')).render(h(StrictMode, null, h(Harness)));
`;

let vite;
let browser;
let baseURL;

before(async () => {
  vite = await createServer({
    root: APP_ROOT,
    cacheDir: path.join(APP_ROOT, 'node_modules', `.vite-message-alert-${process.pid}`),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'message-alert-fixture',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith('/__message-alert')) return next();
          const icon = request.url.includes('noicon') ? '' : `<link rel="icon" type="${ORIGINAL_TYPE}" href="${ORIGINAL_HREF}">`;
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(await server.transformIndexHtml(request.url,
            `<!doctype html><html><head><title>${ORIGINAL_TITLE}</title>${icon}</head><body><div id="root"></div><script type="module">${entry}</script></body></html>`));
        });
      },
    }],
  });
  await vite.listen();
  baseURL = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await vite?.close();
});

async function alertPage(context, suffix = '') {
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  context.after(() => browserContext.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseURL}/__message-alert${suffix}`);
  await page.getByRole('status', { name: 'Unread messages' }).waitFor();
  return { page, errors };
}

async function expectTitle(page, title) {
  await page.waitForFunction(expected => document.title === expected, title, { timeout: 5_000 });
  assert.equal(await page.title(), title);
}

async function iconMetadata(page) {
  return page.locator('link[rel~="icon"]').evaluateAll(nodes => nodes.map(node => ({
    href: node.getAttribute('href'), type: node.getAttribute('type'),
  })));
}

test('unread messages badge the browser tab and update as each conversation is read, including while hidden', async context => {
  const { page, errors } = await alertPage(context);
  assert.equal(await page.title(), ORIGINAL_TITLE);
  assert.deepEqual(await iconMetadata(page), [{ href: ORIGINAL_HREF, type: ORIGINAL_TYPE }]);
  await page.getByRole('button', { name: 'Receive messages' }).click();
  await expectTitle(page, '(3) ClassPilot | Schoolpilot · Teaching');
  assert.deepEqual(await iconMetadata(page), [{ href: '/favicon-unread.svg', type: 'image/svg+xml' }]);

  const away = await page.context().newPage();
  await away.goto('about:blank');
  await away.bringToFront();
  // Headless Chromium reports all tabs visible; simulate the visibility
  // transition explicitly while keeping the hook and DOM effects real.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: 'Read conversation' }).evaluate(button => button.click());
  await expectTitle(page, '(2) ClassPilot | Schoolpilot · Teaching');
  assert.deepEqual(await iconMetadata(page), [{ href: '/favicon-unread.svg', type: 'image/svg+xml' }]);
  await away.close();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await page.getByRole('button', { name: 'Read conversation' }).click();
  await expectTitle(page, '(1) ClassPilot | Schoolpilot · Teaching');
  await page.getByRole('button', { name: 'Read conversation' }).click();
  await expectTitle(page, ORIGINAL_TITLE);
  assert.deepEqual(await iconMetadata(page), [{ href: ORIGINAL_HREF, type: ORIGINAL_TYPE }]);
  assert.deepEqual(errors, []);
});

test('changing classroom and leaving the dashboard restore the exact prior tab metadata', async context => {
  const { page, errors } = await alertPage(context);
  await page.getByRole('button', { name: 'Receive messages' }).click();
  await expectTitle(page, '(3) ClassPilot | Schoolpilot · Teaching');
  await page.getByRole('button', { name: 'Change classroom' }).click();
  await expectTitle(page, ORIGINAL_TITLE);
  assert.deepEqual(await iconMetadata(page), [{ href: ORIGINAL_HREF, type: ORIGINAL_TYPE }]);
  await page.getByRole('button', { name: 'Receive messages' }).click();
  await expectTitle(page, '(3) ClassPilot | Schoolpilot · Teaching');
  await page.getByRole('button', { name: 'Leave classroom' }).click();
  await expectTitle(page, ORIGINAL_TITLE);
  assert.deepEqual(await iconMetadata(page), [{ href: ORIGINAL_HREF, type: ORIGINAL_TYPE }]);
  assert.deepEqual(errors, []);
});

test('dashboard cleanup preserves metadata written by the destination page', async context => {
  const { page, errors } = await alertPage(context);
  await page.getByRole('button', { name: 'Receive messages' }).click();
  await expectTitle(page, '(3) ClassPilot | Schoolpilot · Teaching');
  await page.evaluate(() => {
    document.title = 'PassPilot';
    const icon = document.querySelector('link[rel~="icon"]');
    icon.setAttribute('href', '/passpilot.svg?route=other#icon');
    icon.setAttribute('type', 'image/png');
  });
  await page.getByRole('button', { name: 'Leave classroom' }).click();
  await page.getByText('Other product', { exact: true }).waitFor();
  assert.equal(await page.title(), 'PassPilot');
  assert.deepEqual(await iconMetadata(page), [{ href: '/passpilot.svg?route=other#icon', type: 'image/png' }]);
  assert.deepEqual(errors, []);
});

test('a page without a favicon gets a temporary alert icon and removes it on cleanup', async context => {
  const { page, errors } = await alertPage(context, '?noicon');
  assert.deepEqual(await iconMetadata(page), []);
  await page.getByRole('button', { name: 'Receive messages' }).click();
  await expectTitle(page, '(3) ClassPilot | Schoolpilot · Teaching');
  assert.deepEqual(await iconMetadata(page), [{ href: '/favicon-unread.svg', type: 'image/svg+xml' }]);
  const loaded = await page.evaluate(async () => {
    const image = new Image();
    image.src = '/favicon-unread.svg';
    await image.decode();
    return image.naturalWidth > 0;
  });
  assert.equal(loaded, true, 'The badge points to a usable favicon asset');
  await page.getByRole('button', { name: 'Leave classroom' }).click();
  await expectTitle(page, ORIGINAL_TITLE);
  assert.deepEqual(await iconMetadata(page), []);
  assert.deepEqual(errors, []);
});
