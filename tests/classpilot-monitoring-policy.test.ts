import assert from "node:assert/strict";
import { test } from "node:test";
import { classpilotSafetyObservation, resolveClasspilotMonitoringPolicy, classpilotFullMonitoringDeadline } from "../src/services/classpilotMonitoringPolicy.js";

const settings = {
  enableTrackingHours: true, trackingStartTime: "08:00", trackingEndTime: "15:00",
  trackingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  schoolTimezone: "America/New_York", afterHoursMode: "limited" as const,
};
const capable = { acceptedCapabilities: ["afterHoursSafetyOnlyV1"] };

test("Live View expires at the school policy boundary even when its normal lease runs longer", () => {
  const now = Date.parse("2026-09-08T18:59:30Z");
  const maximum = now + 15 * 60_000;
  assert.equal(classpilotFullMonitoringDeadline(settings, now, maximum), Date.parse("2026-09-08T19:01:00Z"));
  assert.equal(classpilotFullMonitoringDeadline({ ...settings, afterHoursMode: "full" }, now, maximum), maximum);
  assert.equal(classpilotFullMonitoringDeadline(undefined, now, maximum), now);
});

test("limited permits only capable safety observations after hours, preserving full daytime monitoring", () => {
  const day = new Date("2026-09-08T14:00:00Z");
  const night = new Date("2026-09-09T03:00:00Z");
  assert.equal(resolveClasspilotMonitoringPolicy(settings, { ...capable, now: day }).mode, "full");
  assert.equal(resolveClasspilotMonitoringPolicy(settings, { ...capable, now: night }).mode, "safety_only");
  const legacy = resolveClasspilotMonitoringPolicy(settings, { now: night });
  assert.equal(legacy.mode, "off");
  assert.equal(legacy.reason, "extension_update_required");
  assert.equal(legacy.policyMode, "safety_only");
});

test("off/full and disabled hours retain explicit meanings", () => {
  const now = new Date("2026-09-06T16:00:00Z");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...settings, afterHoursMode: "off" }, { ...capable, now }).mode, "off");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...settings, afterHoursMode: "full" }, { now }).mode, "full");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...settings, enableTrackingHours: false }, { now }).mode, "full");
  assert.equal(resolveClasspilotMonitoringPolicy(undefined).mode, "off");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...settings, schoolTimezone: "Invalid/Zone" }).mode, "off");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...settings, trackingStartTime: "99:00" }).mode, "off");
});

test("overnight windows follow their start day and daylight-saving offset", () => {
  const overnight = { ...settings, trackingDays: ["Monday"], trackingStartTime: "20:00", trackingEndTime: "02:00" };
  assert.equal(resolveClasspilotMonitoringPolicy(overnight, { now: new Date("2026-09-08T05:00:00Z") }).mode, "full");
  assert.equal(resolveClasspilotMonitoringPolicy(overnight, { ...capable, now: new Date("2026-09-08T07:00:00Z") }).mode, "safety_only");
  for (const now of ["2026-03-09T12:30:00Z", "2026-11-02T13:30:00Z"]) {
    assert.equal(resolveClasspilotMonitoringPolicy(settings, { now: new Date(now) }).mode, "full");
  }
});

test("safety observation parsing excludes auxiliary telemetry and credentials", () => {
  const observation = classpilotSafetyObservation({ activeTabUrl: "https://example.org/search?q=term#fragment", activeTabTitle: "A\npage", allOpenTabs: [{ url: "https://private.example" }], screenshot: "pixels", cameraActive: true });
  assert.deepEqual(observation, { url: "https://example.org/search?q=term#fragment", title: "A page" });
  assert.notEqual(observation?.url, classpilotSafetyObservation({ activeTabUrl: "https://example.org/search?q=term#different" })?.url);
  for (const activeTabUrl of ["chrome://settings", "file:///private", "https://user:secret@example.org", "not a URL"]) {
    assert.equal(classpilotSafetyObservation({ activeTabUrl }), null);
  }
});

test("school-local closures use after-hours mode even during configured daytime hours", () => {
  const closed = { ...settings, instructionalCalendar: { "2026-09": { nonInstructionalDates: ["2026-09-08"] } } };
  const now = new Date("2026-09-08T14:00:00Z");
  assert.equal(resolveClasspilotMonitoringPolicy(closed, { ...capable, now }).mode, "safety_only");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...closed, afterHoursMode: "off" }, { ...capable, now }).mode, "off");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...closed, afterHoursMode: "full" }, { now }).mode, "full");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...closed, enableTrackingHours: false }, { now }).mode, "full");
  assert.equal(classpilotFullMonitoringDeadline(closed, now.getTime(), now.getTime() + 60_000), now.getTime());
});

test("explicit makeup dates override a closure and follow the selected meeting weekday", () => {
  const saturday = new Date("2026-09-12T14:00:00Z");
  const base = { ...settings, trackingDays: ["Tuesday"] };
  assert.equal(resolveClasspilotMonitoringPolicy(base, { ...capable, now: saturday }).mode, "safety_only");
  const makeup = { ...base, schedulingDateOverrides: { "2026-09-12": { instructional: true, meetingWeekday: 2 } } };
  assert.equal(resolveClasspilotMonitoringPolicy(makeup, { ...capable, now: saturday }).mode, "full");
  assert.equal(resolveClasspilotMonitoringPolicy({ ...makeup, trackingDays: ["Monday"] }, { ...capable, now: saturday }).mode, "safety_only");
  const date = new Date("2026-09-08T14:00:00Z");
  const closed = { ...settings, schedulingDateOverrides: { "2026-09-08": { instructional: false } } };
  assert.equal(resolveClasspilotMonitoringPolicy(closed, { ...capable, now: date }).mode, "safety_only");
});

test("overnight holiday eligibility follows the window's start date across midnight and DST", () => {
  const overnight = { ...settings, trackingDays: ["Monday"], trackingStartTime: "20:00", trackingEndTime: "02:00",
    instructionalCalendar: { "2026-09": { nonInstructionalDates: ["2026-09-07"] } } };
  assert.equal(resolveClasspilotMonitoringPolicy(overnight, { ...capable, now: new Date("2026-09-08T05:00:00Z") }).mode, "safety_only");
  const tuesdayClosed = { ...overnight, instructionalCalendar: { "2026-09": { nonInstructionalDates: ["2026-09-08"] } } };
  assert.equal(resolveClasspilotMonitoringPolicy(tuesdayClosed, { ...capable, now: new Date("2026-09-08T05:00:00Z") }).mode, "full");
  const saturdayMakeup = { ...overnight, schedulingDateOverrides: { "2026-10-31": { instructional: true, meetingWeekday: 1 } } };
  for (const time of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) assert.equal(resolveClasspilotMonitoringPolicy(saturdayMakeup, { ...capable, now: new Date(time) }).mode, "full");
});
