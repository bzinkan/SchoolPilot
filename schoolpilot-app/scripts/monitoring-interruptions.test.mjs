import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

test("monitoring panel groups visible incidents, handles uncertainty, and saves opt-in digest revisions", { timeout: 60_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const testPage = async (req, res, next) => {
    if (req.url !== "/__monitoring-panel-test") return next();
    res.setHeader("Content-Type", "text/html");
    res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__monitoring-panel-entry.jsx"></script></body></html>'));
  };
  const entry = `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClientProvider } from '@tanstack/react-query';
      import { queryClient } from '/src/lib/queryClient.js';
      import Panel, { MonitoringDigestSettings } from '/src/products/classpilot/components/MonitoringInterruptionsPanel.jsx';
      createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(React.Fragment,null,React.createElement(Panel),React.createElement(MonitoringDigestSettings))));
  `;
  const vite = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "monitoring-test-page", configureServer(server) { server.middlewares.use(testPage); }, resolveId(id) { if (id === "/__monitoring-panel-entry.jsx") return "\0monitoring-test-entry"; }, load(id) { if (id === "\0monitoring-test-entry") return entry; } }] });
  await vite.listen();
  const address = vite.httpServer.address();
  let browser;
  let uncertain = false;
  const writes = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith("/csrf")) return route.fulfill({ json: { csrfToken: "test-csrf" } });
      if (url.pathname.endsWith("/monitoring-interruptions/settings")) {
        if (request.method() === "PUT") { const body = request.postDataJSON(); writes.push(body); return route.fulfill({ json: { digestEnabled: body.digestEnabled, revision: 1 } }); }
        return route.fulfill({ json: { digestEnabled: false, revision: 0 } });
      }
      if (url.pathname.endsWith("/monitoring-interruptions")) return route.fulfill({ json: { scanStatus: uncertain ? "uncertain" : "healthy", incidents: [{ id: "incident", studentId: "student", studentName: "Example Student", scopeType: "teaching_session", scopeId: "class-session", scopeName: "7th Math", lastObservedAt: "2026-09-08T13:00:00Z", detectedAt: "2026-09-08T13:01:05Z", endedAt: null, status: uncertain ? "uncertain" : "open", deviceId: "must-never-render", studentSessionId: "private-session" }] } });
      return route.fulfill({ json: {} });
    });
    await page.goto(`http://127.0.0.1:${address.port}/__monitoring-panel-test`);
    await page.getByTestId("monitoring-interruptions-panel").waitFor({ timeout: 15_000 }).catch((error) => { throw new Error(`${error.message}; browser errors: ${browserErrors.join(" | ")}`); });
    await page.getByText("7th Math · 1 open · 1 in the last day").click();
    await page.getByText("Example Student", { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("body").textContent(), /must-never-render|private-session/);
    const toggle = page.getByRole("switch", { name: "Daily monitoring interruption digest" });
    assert.equal(await toggle.getAttribute("data-state"), "unchecked");
    await toggle.click();
    await page.waitForFunction(() => document.getElementById("monitoring-digest-enabled")?.getAttribute("data-state") === "checked");
    assert.deepEqual(writes, [{ digestEnabled: true, expectedRevision: 0 }]);
    uncertain = true;
    await page.getByRole("button", { name: "Refresh monitoring interruptions" }).click();
    await page.getByText("Monitoring status is uncertain. A service interruption may affect these readings.").waitFor();
    await page.getByText("uncertain", { exact: true }).waitFor();
  } finally { await browser?.close(); await vite.close(); }
});
