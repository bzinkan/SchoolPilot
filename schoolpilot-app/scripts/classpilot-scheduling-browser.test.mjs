import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Scheduling sections preserve drafts, protect profile actions, and save only a current reviewed makeup schedule", { timeout: 90_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import { QueryClientProvider } from '@tanstack/react-query';
    import { queryClient } from '/src/lib/queryClient.js';
    import Scheduling from '/src/products/classpilot/pages/AdminScheduling.jsx';
    import { AdminClassesTabs } from '/src/products/classpilot/components/ScheduleRouteTabs.jsx';
    import '/src/index.css';
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(MemoryRouter,{initialEntries:['/classpilot/admin/classes/scheduling']},React.createElement('main',{className:'mx-auto max-w-6xl space-y-6 p-6'},React.createElement(AdminClassesTabs),React.createElement(Scheduling)))));
  `;
  const vite = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "scheduling-browser-test",
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__scheduling-test") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__scheduling-entry.jsx"></script></body></html>'));
    }); },
    resolveId(id) { if (id === "/__scheduling-entry.jsx") return "\0scheduling-test-entry"; },
    load(id) { if (id === "\0scheduling-test-entry") return entry; },
  }] });
  await vite.listen();
  let browser;
  let revision = 1;
  let emptyFixture = false;
  let calendarState = { nonInstructionalDates: [], revision: 0, updatedAt: null };
  let config = { schemaVersion: 1, yearStart: "2026-09-01", yearEnd: "2027-06-30", cycleAnchorDate: "2026-09-01", cycleAnchorDay: "A", periods: [{ id: "p1", name: "Period 1" }], profiles: [{ id: "regular", name: "Regular", periods: { p1: { startTime: "09:00", endTime: "09:50" } } }], defaultProfileId: "regular", weekdayProfiles: {}, dateOverrides: {} };
  const previews = [], writes = [], calendarPreviews = [], calendarWrites = [], calendarReads = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith("/csrf")) return route.fulfill({ json: { csrfToken: "fixture-csrf" } });
      if (url.pathname.endsWith("/schedule-profiles")) return route.fulfill({ json: { revision, schoolTimezone: "America/New_York", schoolLocalToday: "2026-09-01", profiles: emptyFixture ? [] : [{ id: "early", revision: 1, definition: { name: "Early release", grades: [], classIds: ["class"], classRules: [], testingBlocks: [] } }], applications: [], classes: [], staff: [], supervisionGroups: [], testingStatuses: [] } });
      const calendarProjection = (month) => ({ month, schoolTimezone: "America/New_York", schoolLocalToday: "2026-09-01", ...calendarState });
      if (url.pathname.endsWith("/instructional-calendar")) {
        const projection = calendarProjection(url.searchParams.get("month")); calendarReads.push(projection);
        return route.fulfill({ json: projection });
      }
      if (url.pathname.endsWith("/instructional-calendar/2026-09/preview")) {
        calendarPreviews.push(request.postDataJSON());
        return route.fulfill({ json: { previewToken: "reviewed-calendar-token", changedOccurrences: 1, blockers: [], changes: [] } });
      }
      if (url.pathname.endsWith("/instructional-calendar/2026-09") && request.method() === "PUT") {
        const body = request.postDataJSON(); calendarWrites.push(body);
        calendarState = { nonInstructionalDates: body.nonInstructionalDates, revision: calendarState.revision + 1, updatedAt: "2026-09-01T12:00:00.000Z" };
        return route.fulfill({ json: calendarProjection("2026-09") });
      }
      if (url.pathname.endsWith("/admin/scheduling/preview")) {
        const body = request.postDataJSON(); previews.push(body);
        return route.fulfill({ json: { revision, previewToken: `reviewed-weekend-token-${previews.length}`, schoolTimezone: "America/New_York", fromDate: "2026-09-01", throughDate: "2027-06-30", changedOccurrences: 1, blockers: [], changes: [{ date: "2026-09-05", classId: "class", className: "Monday Math", before: null, after: body.config.profiles[0].periods.p1 }], days: [{ date: "2026-09-05", instructional: true, meetingWeekday: 1, cycleDay: "B", profileId: "regular", overridden: true }] } });
      }
      if (url.pathname.endsWith("/admin/scheduling")) {
        if (request.method() === "PUT") { const body = request.postDataJSON(); writes.push(body); config = body.config; revision++; }
        return route.fulfill({ json: { revision, config, schoolTimezone: "America/New_York", schoolLocalToday: "2026-09-01" } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__scheduling-test`);
    await page.getByTestId("classpilot-scheduling-panel").waitFor({ state: "attached" });
    const nav = page.getByRole("navigation", { name: "Class Management sections" });
    assert.deepEqual(await nav.getByRole("link").allTextContents(), ["Classes", "Scheduling", "Schedule Changes"]);
    assert.equal(await nav.getByRole("link", { name: "Scheduling", exact: true }).getAttribute("aria-current"), "page");
    const profilesTab = page.getByRole("tab", { name: "Schedule profiles", exact: true });
    const bellsTab = page.getByRole("tab", { name: "Bells & rotation", exact: true });
    const calendarTab = page.getByRole("tab", { name: "Calendar & exceptions", exact: true });
    const createProfile = page.getByRole("button", { name: "Create Schedule Profile", exact: true });
    const applyProfile = page.getByRole("button", { name: "Apply Early release", exact: true });
    const previewButton = page.getByRole("button", { name: "Preview changes", exact: true });
    const saveButton = page.getByRole("button", { name: "Save reviewed schedule", exact: true });
    const classesShortcut = page.getByRole("link", { name: "assign periods to classes", exact: true });
    const changesShortcut = page.getByRole("link", { name: "Open Schedule Changes", exact: true });
    assert.deepEqual(await page.getByRole("tab").evaluateAll(elements => elements.map(element => element.getAttribute("aria-label"))), ["Schedule profiles", "Bells & rotation", "Calendar & exceptions"]);
    assert.equal(await profilesTab.getAttribute("aria-selected"), "true");
    await applyProfile.waitFor();
    assert.equal(await createProfile.isEnabled(), true);
    assert.equal(await changesShortcut.getAttribute("href"), "/classpilot/admin/classes/schedule-changes");
    assert.equal(await page.getByLabel("School year ends", { exact: true }).isVisible(), false);
    assert.equal(await page.getByLabel("Override date", { exact: true }).isVisible(), false);
    const artifactDir = path.join(root, "artifacts", "scheduling");
    await mkdir(artifactDir, { recursive: true });
    const sections = [
      { key: "profiles", name: "Schedule profiles", tab: profilesTab, marker: 'button "Create Schedule Profile"' },
      { key: "bells", name: "Bells & rotation", tab: bellsTab, marker: 'button "Add period"' },
      { key: "calendar", name: "Calendar & exceptions", tab: calendarTab, marker: 'button "Add date"' },
    ];
    const accessibility = { keyboardTransitions: [], focusIndicators: {}, traversal: {}, views: [] };
    const assertAccessibleSection = async (name) => {
      const selected = sections.find(section => section.name === name);
      assert.equal(await page.locator('[role="tabpanel"]').count(), 3, "All section drafts stay mounted");
      assert.equal(await page.getByRole("tabpanel").count(), 1, "Only the active section belongs in the accessibility tree");
      assert.equal(await page.getByRole("tabpanel").getAttribute("id"), await selected.tab.getAttribute("aria-controls"));
      const snapshot = await page.locator("main").ariaSnapshot();
      for (const section of sections) assert.equal(snapshot.includes(section.marker), section === selected, `${section.name} controls must be exposed only when selected`);
      return snapshot;
    };
    const pressTabKey = async (key, name) => {
      await page.keyboard.press(key);
      await page.waitForFunction(expected => document.activeElement?.getAttribute("aria-label") === expected && document.activeElement?.getAttribute("aria-selected") === "true", name);
      assert.equal(await page.getByRole("tab").evaluateAll(elements => elements.filter(element => element.tabIndex === 0).length), 1, "The tablist has one keyboard entry point");
      assert.equal(await sections.find(section => section.name === name).tab.evaluate(element => element.matches(":focus-visible")), true);
      accessibility.keyboardTransitions.push({ key, selected: name });
      await assertAccessibleSection(name);
    };
    const captureViews = async (population) => {
      let captureIndex = 0;
      for (const [size, viewport] of [["desktop", { width: 1365, height: 950 }], ["mobile", { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        for (const theme of ["light", "dark"]) {
          await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark");
          for (const section of sections) {
            await section.tab.click();
            await assertAccessibleSection(section.name);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${population} ${section.name} must fit ${size} in ${theme} mode`);
          }
          const captured = sections[captureIndex++ % sections.length];
          await captured.tab.click();
          const filename = `${population}-${captured.key}-${size}-${theme}.png`;
          await page.screenshot({ path: path.join(artifactDir, filename), fullPage: true, animations: "disabled" });
          accessibility.views.push({ population, size, theme, checkedSections: sections.map(section => section.key), screenshot: filename });
        }
      }
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await page.setViewportSize({ width: 1365, height: 950 });
    };

    assert.equal(await page.getByRole("tablist", { name: "Scheduling tasks" }).getAttribute("aria-orientation"), "vertical");
    await profilesTab.focus();
    for (const [key, name] of [["ArrowDown", "Bells & rotation"], ["ArrowDown", "Calendar & exceptions"], ["ArrowDown", "Schedule profiles"], ["ArrowUp", "Calendar & exceptions"], ["Home", "Schedule profiles"], ["End", "Calendar & exceptions"], ["ArrowUp", "Bells & rotation"]]) await pressTabKey(key, name);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      await profilesTab.click();
      const restingShadow = await bellsTab.evaluate(element => { element.getAnimations().forEach(animation => animation.finish()); return getComputedStyle(element).boxShadow; });
      await pressTabKey("ArrowDown", "Bells & rotation");
      await page.screenshot({ path: path.join(artifactDir, `keyboard-focus-desktop-${theme}.png`), fullPage: true, animations: "disabled" });
      const focusedShadow = await bellsTab.evaluate(element => getComputedStyle(element).boxShadow);
      assert.notEqual(focusedShadow, restingShadow, `Keyboard focus must paint a visible indicator in ${theme} mode`);
      accessibility.focusIndicators[theme] = { restingShadow, focusedShadow };
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    for (const section of sections) {
      await section.tab.click();
      const snapshot = await assertAccessibleSection(section.name);
      await writeFile(path.join(artifactDir, `${section.key}-accessibility.yml`), snapshot);
      await section.tab.focus();
      let visitedActivePanel = false, reachedHeader = false, stops = 0;
      for (; stops < 90; stops++) {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const element = document.activeElement, panel = element?.closest('[role="tabpanel"]');
          return { panelState: panel?.getAttribute("data-state"), visible: element === document.body || element?.checkVisibility(), header: element?.tagName === "A" && element.textContent.trim() === "Classes" && Boolean(element.closest('nav[aria-label="Class Management sections"]')) };
        });
        assert.notEqual(focused.panelState, "inactive", "Tab must skip every force-mounted inactive panel");
        assert.equal(focused.visible, true, "Keyboard focus must never enter hidden content");
        visitedActivePanel ||= focused.panelState === "active";
        if (focused.header) { reachedHeader = true; break; }
      }
      assert.equal(visitedActivePanel && reachedHeader, true, `${section.name} keyboard traversal must visit its content and complete without entering hidden sections`);
      accessibility.traversal[section.key] = { stops: stops + 1, visitedActivePanel, reachedHeader };
    }
    await profilesTab.click();
    await page.screenshot({ path: path.join(artifactDir, "profiles-desktop.png"), fullPage: true, animations: "disabled" });

    await bellsTab.click();
    assert.equal(await classesShortcut.getAttribute("href"), "/classpilot/admin/classes");
    await page.getByLabel("School year ends", { exact: true }).fill("2027-06-29");
    await page.getByLabel("Regular Period 1 start", { exact: true }).fill("09:05");
    assert.equal(await classesShortcut.count(), 0, "A schedule draft must hide the shortcut out to Classes");
    assert.equal(await changesShortcut.count(), 0, "A schedule draft must hide the shortcut out to Schedule Changes");
    assert.equal(await page.getByLabel("Override date", { exact: true }).isVisible(), false);
    await page.screenshot({ path: path.join(artifactDir, "bells-desktop.png"), fullPage: true, animations: "disabled" });

    await calendarTab.click();
    const closureDay = page.getByTestId("calendar-day-2026-09-08");
    await closureDay.click();
    await page.getByTestId("calendar-dirty-bar").waitFor();
    assert.equal(await previewButton.isDisabled(), true, "A calendar draft must be saved or discarded before a bell preview");
    await profilesTab.click();
    assert.equal(await createProfile.isDisabled(), true, "Changing sections must not unblock profile creation while a draft exists");
    assert.equal(await applyProfile.isDisabled(), true, "Changing sections must not unblock profile application while a draft exists");
    await calendarTab.click();
    assert.equal(await closureDay.getAttribute("aria-pressed"), "true", "Calendar selections must survive switching sections");
    await page.getByTestId("button-discard-calendar").click();
    await page.getByTestId("calendar-dirty-bar").waitFor({ state: "hidden" });
    assert.equal(await previewButton.isEnabled(), true);

    await page.getByLabel("Override date", { exact: true }).fill("2026-09-05");
    await page.getByRole("button", { name: "Add date", exact: true }).click();
    await page.getByLabel("2026-09-05 instructional status").selectOption("true");
    await page.getByLabel("2026-09-05 meeting weekday").selectOption("1");
    await page.getByLabel("2026-09-05 A/B day").selectOption("B");
    await page.getByLabel("2026-09-05 bell profile").selectOption("regular");
    await bellsTab.click();
    assert.equal(await page.getByLabel("School year ends", { exact: true }).inputValue(), "2027-06-29");
    assert.equal(await page.getByLabel("Regular Period 1 start", { exact: true }).inputValue(), "09:05");
    await profilesTab.click();
    assert.equal(await createProfile.isDisabled(), true, "The bell and date override draft must continue blocking profiles after a calendar draft is discarded");
    await calendarTab.click();
    assert.equal(await page.getByLabel("2026-09-05 instructional status").inputValue(), "true");
    assert.equal(await page.getByLabel("2026-09-05 meeting weekday").inputValue(), "1");
    assert.equal(await page.getByLabel("2026-09-05 A/B day").inputValue(), "B");
    assert.equal(await page.getByLabel("2026-09-05 bell profile").inputValue(), "regular");

    await closureDay.click();
    await page.getByRole("button", { name: "Preview month changes", exact: true }).click();
    await page.getByRole("button", { name: "Save reviewed month", exact: true }).waitFor();
    assert.deepEqual(calendarPreviews, [{ nonInstructionalDates: ["2026-09-08"] }]);
    const verifiedMonth = page.waitForResponse(response => response.request().method() === "GET" && response.url().includes("/instructional-calendar?month=2026-09"));
    await page.getByRole("button", { name: "Save reviewed month", exact: true }).click();
    await verifiedMonth;
    await page.getByTestId("calendar-dirty-bar").waitFor({ state: "hidden" });
    assert.deepEqual(calendarWrites, [{ expectedRevision: 0, nonInstructionalDates: ["2026-09-08"], previewToken: "reviewed-calendar-token" }]);
    assert.equal(calendarReads.at(-1).revision, 1, "The saved month must be read back before its draft clears");
    assert.equal(await closureDay.getAttribute("aria-pressed"), "true");
    assert.equal(writes.length, 0, "Saving a calendar month must not save the separate bell/date draft");
    assert.equal(previews.length, 0, "A month preview uses its independent endpoint");
    await bellsTab.click();
    assert.equal(await page.getByLabel("School year ends", { exact: true }).inputValue(), "2027-06-29");
    assert.equal(await page.getByLabel("Regular Period 1 start", { exact: true }).inputValue(), "09:05");
    await profilesTab.click();
    assert.equal(await createProfile.isDisabled(), true, "Saving the month must not clear another section's draft protection");
    await calendarTab.click();
    assert.equal(await page.getByLabel("2026-09-05 A/B day").inputValue(), "B");
    assert.equal(await page.getByLabel("2026-09-05 meeting weekday").inputValue(), "1");

    assert.equal(await saveButton.count(), 0);
    await previewButton.click();
    await page.getByText("B · Monday meetings", { exact: true }).waitFor({ timeout: 10_000 }).catch(async (error) => { throw new Error(`${error.message}; preview requests: ${JSON.stringify(previews)}; errors: ${JSON.stringify(errors)}; body: ${await page.locator('body').innerText()}`); });
    assert.deepEqual(previews[0].config.dateOverrides["2026-09-05"], { instructional: true, meetingWeekday: 1, cycleDay: "B", profileId: "regular" });
    assert.equal(previews[0].config.yearEnd, "2027-06-29");
    assert.equal(previews[0].config.profiles[0].periods.p1.startTime, "09:05");
    assert.equal(await saveButton.isEnabled(), true);
    await calendarTab.focus();
    await pressTabKey("Home", "Schedule profiles");
    assert.equal(await saveButton.count(), 0, "The retained preview is hidden with its schedule editor");
    await pressTabKey("End", "Calendar & exceptions");
    assert.equal(await saveButton.isEnabled(), true, "The reviewed preview must survive a keyboard trip through another section");
    assert.equal(previews.length, 1, "Navigation alone must not request a replacement preview");
    await pressTabKey("ArrowUp", "Bells & rotation");
    assert.equal(await page.getByLabel("School year ends", { exact: true }).inputValue(), "2027-06-29");
    await page.getByLabel("Regular Period 1 end", { exact: true }).fill("09:55");
    assert.equal(await saveButton.count(), 0, "Editing another section after preview must remove approval for the old draft");
    assert.equal(writes.length, 0);
    await calendarTab.click();
    assert.equal(await saveButton.count(), 0);
    await previewButton.click();
    await saveButton.waitFor();
    assert.equal(previews.length, 2);
    assert.equal(previews[1].config.profiles[0].periods.p1.endTime, "09:55");
    await page.screenshot({ path: path.join(artifactDir, "calendar-preview-desktop.png"), fullPage: true, animations: "disabled" });
    const refreshed = page.waitForResponse((response) => response.url().endsWith("/admin/scheduling") && response.request().method() === "GET");
    await saveButton.click();
    await refreshed;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expectedRevision, 1);
    assert.equal(writes[0].previewToken, "reviewed-weekend-token-2");
    assert.deepEqual(writes[0].config, previews[1].config, "Saving must use the latest reviewed draft, including changes from every section");
    assert.equal(await page.getByLabel("2026-09-05 instructional status").inputValue(), "true");
    assert.equal(await page.getByLabel("2026-09-05 meeting weekday").inputValue(), "1");
    await profilesTab.click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="schedule-profiles"] button')?.disabled);
    assert.equal(await createProfile.isEnabled(), true);
    assert.equal(await applyProfile.isEnabled(), true);
    await changesShortcut.waitFor();
    await bellsTab.click();
    assert.equal(await classesShortcut.isVisible(), true, "Saving restores the Classes shortcut");

    await calendarTab.click();
    await closureDay.click();
    await page.getByTestId("calendar-dirty-bar").waitFor();
    assert.equal(await changesShortcut.count(), 0, "A calendar-only draft must also hide the shortcut out to Schedule Changes");
    await bellsTab.click();
    assert.equal(await classesShortcut.count(), 0, "A calendar-only draft must also hide the shortcut out to Classes");
    await calendarTab.click();
    await page.getByTestId("button-discard-calendar").click();
    await changesShortcut.waitFor();
    await bellsTab.click();
    assert.equal(await classesShortcut.isVisible(), true, "Discarding the calendar draft restores the Classes shortcut");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: path.join(artifactDir, "bells-dark-desktop.png"), fullPage: true, animations: "disabled" });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of [profilesTab, bellsTab, calendarTab]) {
      await tab.click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${await tab.innerText()} must fit a narrow viewport`);
    }
    await page.screenshot({ path: path.join(artifactDir, "calendar-mobile.png"), fullPage: true, animations: "disabled" });
    await captureViews("populated");

    emptyFixture = true;
    calendarState = { nonInstructionalDates: [], revision: 0, updatedAt: null };
    config = { ...config, yearStart: null, yearEnd: null, cycleAnchorDate: null, periods: [], profiles: [], defaultProfileId: null, weekdayProfiles: {}, dateOverrides: {} };
    await page.setViewportSize({ width: 1365, height: 950 });
    await page.reload();
    await page.getByText("No profiles yet. Create your first special-day plan, then apply it to the dates you need.", { exact: true }).waitFor();
    assert.equal(await createProfile.isEnabled(), true);
    await page.screenshot({ path: path.join(artifactDir, "profiles-empty-desktop.png"), fullPage: true, animations: "disabled" });
    await bellsTab.click();
    const addBellProfile = page.getByRole("button", { name: "Add bell profile", exact: true });
    const prerequisiteHint = page.getByText("Add a period above before creating a bell profile.", { exact: true });
    assert.equal(await addBellProfile.isDisabled(), true, "An empty school needs a period before a bell profile can be created");
    assert.equal(await prerequisiteHint.isVisible(), true, "The disabled action must explain its prerequisite");
    await page.screenshot({ path: path.join(artifactDir, "bells-empty-desktop.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Add period", exact: true }).click();
    assert.equal(await addBellProfile.isEnabled(), true);
    assert.equal(await prerequisiteHint.count(), 0);
    assert.equal(await classesShortcut.count(), 0);
    assert.equal(await changesShortcut.count(), 0);
    await page.getByRole("button", { name: "Discard schedule draft", exact: true }).click();
    await changesShortcut.waitFor();
    assert.equal(await classesShortcut.isVisible(), true, "Discarding the schedule draft restores the Classes shortcut");
    assert.equal(await addBellProfile.isDisabled(), true);
    assert.equal(await prerequisiteHint.isVisible(), true);
    assert.equal(writes.length, 1, "Adding and discarding an empty-school period must not save it");
    await captureViews("empty");
    await writeFile(path.join(artifactDir, "accessibility-evidence.json"), JSON.stringify({ ...accessibility, calendarSave: { previews: calendarPreviews.length, writes: calendarWrites.length, verifiedRevision: calendarReads.find(read => read.revision === 1)?.revision, retainedSeparateDraft: true } }, null, 2));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await vite.close(); }
});
