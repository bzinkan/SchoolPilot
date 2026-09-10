import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshots = path.resolve(root, "../soc2-evidence/monitoring-summary/browser");
const summary = (scanStatus = "healthy", open = 0, recent = 523) => ({ scanStatus, asOf: new Date().toISOString(), windowStart: new Date(Date.now() - 86400000).toISOString(), lastScannedAt: new Date().toISOString(), counts: { open, last24Hours: recent } });
const incident = (index, values = {}) => ({ id: `event-${index}`, studentId: "student", studentName: `Example Student ${index}`, scopeType: "teaching_session", scopeId: "class-session", scopeName: "7th Math", lastObservedAt: "2026-09-08T13:00:00Z", detectedAt: "2026-09-08T13:01:05Z", endedAt: "2026-09-08T13:10:00Z", endReason: "telemetry_resumed", status: "recovered", deviceId: "must-never-render", studentSessionId: "private-session", ...values });

async function assertHistoryPanels(dialog, selectedName) {
  for (const tab of await dialog.getByRole("tab").all()) {
    const relationship = await tab.evaluate(element => {
      const panel = document.getElementById(element.getAttribute("aria-controls"));
      return { role: panel?.getAttribute("role"), labelledBy: panel?.getAttribute("aria-labelledby"), tabId: element.id, visible: Boolean(panel?.getClientRects().length), selected: element.getAttribute("aria-selected") === "true" };
    });
    assert.equal(relationship.role, "tabpanel");
    assert.equal(relationship.labelledBy, relationship.tabId);
    assert.equal(relationship.visible, relationship.selected);
  }
  assert.equal(await dialog.getByRole("tabpanel", { name: selectedName, exact: true }).count(), 1);
}

async function fixture(t, role = "school_admin") {
  const entry = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {QueryClientProvider} from '@tanstack/react-query';
    import {AuthProvider,useAuth} from '/src/contexts/AuthContext.jsx';
    import {queryClient} from '/src/lib/queryClient.js';
    import Panel,{MonitoringDigestSettings} from '/src/products/classpilot/components/MonitoringInterruptionsPanel.jsx';
    import '/src/index.css';
    queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});
    function Content(){const auth=useAuth();React.useEffect(()=>{window.__switchMonitoringSchool=auth.switchSchool;window.__refreshMonitoringActor=auth.refetchUser;},[auth.switchSchool,auth.refetchUser]);return React.createElement(React.Fragment,null,React.createElement(Panel),auth.activeMembership?.role==='school_admin'&&React.createElement(MonitoringDigestSettings));}
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(Content))));
  `;
  const vite = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "monitoring-test-page", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__monitoring-panel-test") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__monitoring-panel-entry.jsx"></script></body></html>'));
    });
  }, resolveId(id) { if (id === "/__monitoring-panel-entry.jsx") return "\0monitoring-test-entry"; }, load(id) { if (id === "\0monitoring-test-entry") return entry; } }] });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  const state = { role, actor: "staff", summary: summary(), writes: [], reads: [], errors: [], historyMode: "success", summaryMode: "success", releaseHistory: null, releaseSummary: null, historyStarted: null, summaryStarted: null };
  t.after(async () => { state.releaseHistory?.(); state.releaseSummary?.(); await browser.close(); await vite.close(); });
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("sp_activeSchoolId", "school"));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), schoolId = request.headers()["x-school-id"] || "school";
    if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { user: { id: state.actor }, activeSchoolId: schoolId, memberships: [{ schoolId: "school", role: state.role }, { schoolId: "other-school", role: state.role }], licenses: { classPilot: true } } });
    if (url.pathname.endsWith("/csrf")) return route.fulfill({ json: { csrfToken: "test-csrf" } });
    if (url.pathname.endsWith("/monitoring-interruptions/settings")) {
      if (request.method() === "PUT") { const body = request.postDataJSON(); state.writes.push({ body, schoolId }); return route.fulfill({ json: { digestEnabled: body.digestEnabled, revision: 1 } }); }
      return route.fulfill({ json: { digestEnabled: false, revision: 0 } });
    }
    if (url.pathname.endsWith("/monitoring-interruptions")) {
      const view = url.searchParams.get("view"), filter = url.searchParams.get("filter"), cursor = url.searchParams.get("cursor");
      state.reads.push({ view, filter, cursor, schoolId, actor: state.actor });
      const payload = schoolId === "other-school" || state.actor === "other-staff" ? summary("healthy", 0, 7) : structuredClone(state.summary);
      if (view === "summary") {
        if (state.summaryMode === "pending") await new Promise(resolve => { state.releaseSummary = resolve; state.summaryStarted?.(); });
        if (state.summaryMode === "error") return route.fulfill({ status: 503, json: { error: "Monitoring service is temporarily unavailable." } });
        return route.fulfill({ json: state.summaryMode === "malformed" ? {} : payload });
      }
      if (view === "history") {
        if (state.historyMode === "pending") await new Promise(resolve => { state.releaseHistory = resolve; state.historyStarted?.(); });
        if (state.historyMode === "error") return route.fulfill({ status: 503, json: { error: "History is temporarily unavailable." } });
        const rows = filter === "open" ? [incident("old", { studentName: "Older open event", detectedAt: "2026-09-06T13:01:05Z", endedAt: null, status: "open" })]
          : cursor ? [incident(51, { endReason: "scope_or_binding_ended", status: "ended" })] : Array.from({ length: 50 }, (_, i) => incident(i + 1));
        return route.fulfill({ json: { ...payload, filter, incidents: rows, nextCursor: filter === "recent" && !cursor ? "page-two" : null } });
      }
      throw new Error("Monitoring must use summary or history mode");
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__monitoring-panel-test`);
  await page.getByText("No open monitoring interruptions", { exact: false }).waitFor();
  return { page, state };
}

test("compact exact counts load without student details; history pages and digest remain accessible", { timeout: 120000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByText("No open monitoring interruptions · 523 events in the last 24 hours").waitFor();
  const panel = page.getByTestId("monitoring-interruptions-panel");
  await panel.getByText("Last check:", { exact: false }).waitFor();
  assert.equal(await panel.locator("time").getAttribute("datetime"), state.summary.lastScannedAt);
  assert.equal(state.reads.some(read => read.view === "history"), false);
  assert.equal(await page.getByText("Example Student 1", { exact: true }).count(), 0);
  const opener = page.getByRole("button", { name: "View recent history" });
  await opener.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Monitoring interruption history" });
  await dialog.getByText("Example Student 1", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("tab", { name: "Last 24 hours" }).getAttribute("aria-selected"), "true");
  await assertHistoryPanels(dialog, "Last 24 hours");
  assert.equal(await dialog.locator("article").count(), 50);
  assert.doesNotMatch(await dialog.textContent(), /must-never-render|private-session/);
  await dialog.getByRole("button", { name: "Next page" }).click();
  await dialog.getByText("Example Student 51", { exact: true }).waitFor();
  await dialog.getByText("Class or sign-in ended", { exact: false }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Next page" }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Previous page" }).click();
  await dialog.getByText("Example Student 1", { exact: true }).waitFor();
  await dialog.getByRole("tab", { name: "Last 24 hours", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await dialog.getByText("Older open event").waitFor();
  await assertHistoryPanels(dialog, "Open");
  assert.equal(await dialog.getByRole("tab", { name: "Open", exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await dialog.getByRole("button", { name: "Next page" }).isDisabled(), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(el => el === document.activeElement, await opener.elementHandle());
  assert.equal(await opener.evaluate(el => el === document.activeElement), true);
  const toggle = page.getByRole("switch", { name: "Daily monitoring interruption digest" });
  await toggle.click(); await page.waitForFunction(() => document.getElementById("monitoring-digest-enabled")?.getAttribute("data-state") === "checked");
  assert.deepEqual(state.writes, [{ schoolId: "school", body: { digestEnabled: true, expectedRevision: 0 } }]);
  await mkdir(screenshots, { recursive: true });
  for (const theme of ["light", "dark"]) for (const [size, width] of [["desktop", 1280], ["mobile", 390]]) {
    await page.setViewportSize({ width, height: 844 }); await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.getByTestId("monitoring-interruptions-panel").screenshot({ path: path.join(screenshots, `summary-${size}-${theme}.png`) });
    await opener.click(); await dialog.getByText("Example Student 1", { exact: true }).waitFor();
    await dialog.screenshot({ path: path.join(screenshots, `history-${size}-${theme}.png`) });
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.keyboard.press("Escape");
  }
  assert.deepEqual(state.errors, []);
});

test("unknown, unavailable and failed reads never show a healthy zero and history can retry", { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t, "teacher");
  const panel = page.getByTestId("monitoring-interruptions-panel");
  state.summaryMode = "pending";
  const started = new Promise(resolve => { state.summaryStarted = resolve; });
  await page.getByRole("button", { name: "Refresh monitoring interruptions" }).click(); await started;
  await panel.getByText("Checking monitoring status…", { exact: false }).waitFor();
  assert.equal(await panel.getByText("No open monitoring interruptions", { exact: false }).count(), 0);
  state.summaryMode = "success"; state.releaseSummary();
  await panel.getByText("No open monitoring interruptions", { exact: false }).waitFor();
  for (const status of ["uncertain", "unknown", "not_expected"]) {
    state.summary = summary(status);
    await page.getByRole("button", { name: "Refresh monitoring interruptions" }).click();
    await panel.getByText(status === "not_expected" ? "Full classroom monitoring is not currently expected." : "Monitoring status is uncertain.", { exact: false }).waitFor();
    assert.equal(await panel.getByText("No open monitoring interruptions", { exact: false }).count(), 0);
    assert.equal(await panel.getByRole("button", { name: "View interruption history", exact: true }).count(), 1);
  }
  state.summary = { ...summary(), lastScannedAt: new Date(Date.now() - 240000).toISOString() };
  await page.getByRole("button", { name: "Refresh monitoring interruptions" }).click();
  await panel.getByText("Monitoring status is uncertain.", { exact: false }).waitFor();
  assert.equal(await panel.getByText("No open monitoring interruptions", { exact: false }).count(), 0);
  assert.equal(await panel.locator("time").getAttribute("datetime"), state.summary.lastScannedAt);
  state.summary = { ...summary(), lastScannedAt: null };
  await page.getByRole("button", { name: "Refresh monitoring interruptions" }).click();
  await panel.getByText("Last check unavailable", { exact: true }).waitFor();
  await panel.getByText("Monitoring status is uncertain.", { exact: false }).waitFor();
  state.summaryMode = "error";
  await page.getByRole("button", { name: "Refresh monitoring interruptions" }).click();
  await panel.getByText("Monitoring service is temporarily unavailable.", { exact: false }).waitFor();
  state.summaryMode = "malformed";
  await page.getByRole("button", { name: "Refresh monitoring interruptions" }).click();
  await panel.getByText("Monitoring status is temporarily unavailable.", { exact: false }).waitFor();
  assert.equal(await panel.getByText("No open monitoring interruptions", { exact: false }).count(), 0);
  state.summaryMode = "success"; state.summary = summary("healthy", 2);
  await page.getByRole("button", { name: "Refresh monitoring interruptions" }).click();
  await panel.getByText("2 open interruptions", { exact: false }).waitFor();
  state.historyMode = "error";
  await page.getByRole("button", { name: "Review open interruptions" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("History is temporarily unavailable.").waitFor();
  state.historyMode = "success";
  await dialog.getByRole("button", { name: "Retry history" }).click();
  await dialog.getByText("Older open event").waitFor();
  assert.equal(await dialog.getByRole("tab", { name: "Open", exact: true }).getAttribute("aria-selected"), "true");
  state.historyMode = "error";
  await dialog.getByRole("button", { name: "Refresh history" }).click();
  await dialog.getByText("History is temporarily unavailable.").waitFor();
  await dialog.getByText("Older open event").waitFor();
  await dialog.getByText("uncertain", { exact: true }).waitFor();
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.errors, []);
});

test("history cancels on school or actor changes and remains available to office staff", { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t, "office_staff");
  assert.equal(await page.getByTestId("monitoring-digest-settings").count(), 0);
  state.historyMode = "pending";
  const started = new Promise(resolve => { state.historyStarted = resolve; });
  await page.getByRole("button", { name: "View recent history" }).click(); await started;
  await page.evaluate(() => window.__switchMonitoringSchool("other-school"));
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("No open monitoring interruptions · 7 events in the last 24 hours").waitFor();
  state.historyMode = "success"; state.releaseHistory();
  assert.equal(await page.getByText("Example Student 1", { exact: true }).count(), 0);
  await page.evaluate(() => window.__switchMonitoringSchool("school"));
  await page.getByText("523 events in the last 24 hours", { exact: false }).waitFor();
  await page.getByRole("button", { name: "View recent history" }).click();
  await page.getByText("Example Student 1", { exact: true }).waitFor();
  state.actor = "other-staff";
  await page.evaluate(() => window.__refreshMonitoringActor());
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("No open monitoring interruptions · 7 events in the last 24 hours").waitFor();
  assert.equal(await page.getByText("Example Student 1", { exact: true }).count(), 0);
  assert.ok(state.reads.some(read => read.schoolId === "other-school" && read.view === "summary"));
  assert.ok(state.reads.some(read => read.actor === "other-staff" && read.view === "summary"));
  assert.equal(state.writes.length, 0); assert.deepEqual(state.errors, []);
});
