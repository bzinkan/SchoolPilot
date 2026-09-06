import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Scheduling middle tab reviews and saves weekend makeup with preserved A/B and profile overrides", { timeout: 60_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import { QueryClientProvider } from '@tanstack/react-query';
    import { queryClient } from '/src/lib/queryClient.js';
    import Scheduling from '/src/products/classpilot/pages/AdminScheduling.jsx';
    import { AdminClassesTabs } from '/src/products/classpilot/components/ScheduleRouteTabs.jsx';
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(MemoryRouter,{initialEntries:['/classpilot/admin/classes/scheduling']},React.createElement(React.Fragment,null,React.createElement(AdminClassesTabs),React.createElement(Scheduling)))));
  `;
  const vite = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "scheduling-browser-test",
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__scheduling-test") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__scheduling-entry.jsx"></script></body></html>'));
    }); },
    resolveId(id) { if (id === "/__scheduling-entry.jsx") return "\0scheduling-test-entry"; },
    load(id) { if (id === "\0scheduling-test-entry") return entry; },
  }] });
  await vite.listen();
  let browser;
  let revision = 1;
  let config = { schemaVersion: 1, yearStart: "2026-09-01", yearEnd: "2027-06-30", cycleAnchorDate: "2026-09-01", cycleAnchorDay: "A", periods: [{ id: "p1", name: "Period 1" }], profiles: [{ id: "regular", name: "Regular", periods: { p1: { startTime: "09:00", endTime: "09:50" } } }], defaultProfileId: "regular", weekdayProfiles: {}, dateOverrides: {} };
  const previews = [], writes = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith("/csrf")) return route.fulfill({ json: { csrfToken: "fixture-csrf" } });
      if (url.pathname.endsWith("/instructional-calendar")) return route.fulfill({ json: { month: url.searchParams.get("month"), schoolTimezone: "America/New_York", schoolLocalToday: "2026-09-01", nonInstructionalDates: [], revision: 0, updatedAt: null } });
      if (url.pathname.endsWith("/admin/scheduling/preview")) {
        const body = request.postDataJSON(); previews.push(body);
        return route.fulfill({ json: { revision, previewToken: "reviewed-weekend-token", schoolTimezone: "America/New_York", fromDate: "2026-09-01", throughDate: "2027-06-30", changedOccurrences: 1, blockers: [], changes: [{ date: "2026-09-05", classId: "class", className: "Monday Math", before: null, after: { startTime: "09:00", endTime: "09:50" } }], days: [{ date: "2026-09-05", instructional: true, meetingWeekday: 1, cycleDay: "B", profileId: "regular", overridden: true }] } });
      }
      if (url.pathname.endsWith("/admin/scheduling")) {
        if (request.method() === "PUT") { const body = request.postDataJSON(); writes.push(body); config = body.config; revision++; }
        return route.fulfill({ json: { revision, config, schoolLocalToday: "2026-09-01" } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__scheduling-test`);
    await page.getByTestId("classpilot-scheduling-panel").waitFor();
    const nav = page.getByRole("navigation", { name: "Class Management sections" });
    assert.deepEqual(await nav.getByRole("link").allTextContents(), ["Classes", "Scheduling", "Schedule Changes"]);
    assert.equal(await nav.getByRole("link", { name: "Scheduling", exact: true }).getAttribute("aria-current"), "page");
    await page.getByLabel("Override date", { exact: true }).fill("2026-09-05");
    await page.getByRole("button", { name: "Add date", exact: true }).click();
    await page.getByLabel("2026-09-05 instructional status").selectOption("true");
    await page.getByLabel("2026-09-05 meeting weekday").selectOption("1");
    await page.getByLabel("2026-09-05 A/B day").selectOption("B");
    await page.getByLabel("2026-09-05 bell profile").selectOption("regular");
    assert.equal(await page.getByRole("button", { name: "Save reviewed schedule" }).count(), 0);
    await page.getByRole("button", { name: "Preview changes", exact: true }).click();
    await page.getByText("B · Monday meetings", { exact: true }).waitFor({ timeout: 10_000 }).catch(async (error) => { throw new Error(`${error.message}; preview requests: ${JSON.stringify(previews)}; errors: ${JSON.stringify(errors)}; body: ${await page.locator('body').innerText()}`); });
    assert.deepEqual(previews[0].config.dateOverrides["2026-09-05"], { instructional: true, meetingWeekday: 1, cycleDay: "B", profileId: "regular" });
    const refreshed = page.waitForResponse((response) => response.url().endsWith("/admin/scheduling") && response.request().method() === "GET");
    await page.getByRole("button", { name: "Save reviewed schedule" }).click();
    await refreshed;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expectedRevision, 1);
    assert.equal(writes[0].previewToken, "reviewed-weekend-token");
    assert.equal(await page.getByLabel("2026-09-05 instructional status").inputValue(), "true");
    assert.equal(await page.getByLabel("2026-09-05 meeting weekday").inputValue(), "1");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await vite.close(); }
});
