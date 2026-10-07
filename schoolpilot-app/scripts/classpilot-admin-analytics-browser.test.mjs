import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

test("class analytics shows daily averages across date selectors without cumulative fallbacks", { timeout: 90_000 }, async (context) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { ThemeProvider } from '/src/contexts/ThemeContext.jsx';
    import { AdminNavigationContext } from '/src/products/classpilot/hooks/useAdminNavigation.js';
    import AdminAnalytics from '/src/products/classpilot/pages/AdminAnalytics.jsx';
    import '/src/index.css';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    createRoot(document.getElementById('root')).render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(ThemeProvider, null,
          React.createElement(MemoryRouter, null,
            React.createElement(AdminNavigationContext.Provider, { value: { shell: true } }, React.createElement(AdminAnalytics))))))
  `;
  const vite = await createServer({
    root,
    cacheDir: path.join(root, "node_modules", `.vite-admin-analytics-${process.pid}`),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "admin-analytics-browser-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__analytics-test") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__analytics-entry.jsx"></script></body></html>'));
        });
      },
      resolveId(id) { if (id === "/__analytics-entry.jsx") return "\0analytics-test-entry"; },
      load(id) { if (id === "\0analytics-test-entry") return entry; },
    }],
  });
  let browser;
  context.after(async () => { await browser?.close(); await vite.close(); });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const periodsRead = [];
  let rosterMode = false;
  const baseRow = { groupId: "math", groupName: "Grade 5 Math", gradeLevel: "5", teacherName: "Mr. Zinkan", studentCount: 23, activeStudentCount: 23, totalBrowsingMinutes: 4801, avgMinutesPerStudent: 209 };
  const periods = {
    today: { avgDailyMinutesPerActiveStudent: 70, activeStudentDayCount: 23, activeClassDayCount: 1 },
    "7d": { avgDailyMinutesPerActiveStudent: 42, activeStudentDayCount: 115, activeClassDayCount: 5 },
    "30d": { avgDailyMinutesPerActiveStudent: 40, activeStudentDayCount: 460, activeClassDayCount: 20 },
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/admin/analytics/by-group")) {
      const period = url.searchParams.get("period");
      periodsRead.push(period);
      return route.fulfill({ json: { attributionMode: rosterMode ? "roster" : "session", groups: [
        { ...baseRow, ...periods[period], ...(rosterMode ? { avgDailyMinutesPerActiveStudent: null, activeStudentDayCount: null, activeClassDayCount: null } : {}) },
        { ...baseRow, groupId: "older-api", groupName: "Unavailable daily data" },
        { ...baseRow, groupId: "no-usage", groupName: "No recorded usage", totalBrowsingMinutes: 0, avgDailyMinutesPerActiveStudent: null, activeStudentDayCount: 0, activeClassDayCount: 0 },
      ] } });
    }
    if (url.pathname.endsWith("/admin/analytics/summary")) return route.fulfill({ json: { summary: {}, topWebsites: [], hourlyActivity: [] } });
    return route.fulfill({ json: {} });
  });
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/__analytics-test`;
  await page.goto(url);
  await page.getByRole("cell", { name: "42m", exact: true }).waitFor();
  const table = page.locator("table").last();
  assert.deepEqual(await table.getByRole("columnheader").allTextContents(), ["Class", "Teacher", "Total Usage", "Days with Usage", "Daily Avg / Active Student"]);
  const mathRow = table.getByRole("row").filter({ hasText: "Grade 5 Math" });
  assert.deepEqual((await mathRow.getByRole("cell").allTextContents()).slice(1), ["Mr. Zinkan", "80h 1m", "5", "42m"]);
  assert.equal(await table.getByRole("row").filter({ hasText: "Unavailable daily data" }).getByRole("cell").last().textContent(), "—");
  assert.equal(await table.getByRole("row").filter({ hasText: "No recorded usage" }).getByRole("cell").last().textContent(), "—");
  await page.getByText("Daily average includes only students with recorded class usage on each day. Total Usage covers the selected date range.", { exact: true }).waitFor();
  const artifactDir = path.join(root, "artifacts", "admin-analytics");
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, "daily-average-desktop.png"), fullPage: true });
  for (const [label, dailyAverage, dayCount] of [["Today", "1h 10m", "1"], ["Last 30 days", "40m", "20"], ["Last 7 days", "42m", "5"]]) {
    await page.getByRole("combobox").last().click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await mathRow.getByRole("cell", { name: dailyAverage, exact: true }).waitFor();
    assert.equal(await mathRow.getByRole("cell").nth(3).textContent(), dayCount);
  }
  assert.ok(["today", "7d", "30d"].every((period) => periodsRead.includes(period)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifactDir, "daily-average-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("div")]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
      .slice(0, 5).map((element) => ({ classes: element.className, width: element.getBoundingClientRect().width })))));
  rosterMode = true;
  await page.reload();
  await page.getByRole("cell", { name: "3h 29m", exact: true }).first().waitFor();
  assert.equal(await page.getByRole("columnheader", { name: "Daily Avg / Active Student", exact: true }).count(), 0);
  assert.equal(await page.getByRole("columnheader", { name: "Days with Usage", exact: true }).count(), 0);
  await page.getByRole("columnheader", { name: "Avg / Active Student", exact: true }).waitFor();
  assert.deepEqual(await table.getByRole("columnheader").allTextContents(), ["Class", "Teacher", "Total Usage", "Avg / Active Student"]);
  assert.deepEqual((await mathRow.getByRole("cell").allTextContents()).slice(1), ["Mr. Zinkan", "80h 1m", "3h 29m"]);
  assert.deepEqual(errors, []);
});
