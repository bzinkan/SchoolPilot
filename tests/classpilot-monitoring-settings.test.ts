import assert from "node:assert/strict";
import { test } from "node:test";
import { assertClasspilotMonitoringSettingsUpdate as validate, assertClasspilotMonitoringTimezoneUpdate as validateTimezone } from "../src/services/classpilotMonitoringSettings.js";

const current = { enableTrackingHours: true, trackingStartTime: "08:00", trackingEndTime: "15:00", trackingDays: ["Monday"], schoolTimezone: "America/New_York", afterHoursMode: "off" };
const invalid = { code: "CLASSPILOT_MONITORING_SETTINGS_INVALID", status: 400 };

test("limited monitoring cannot be saved with hours disabled, including partial edits", () => {
  assert.throws(() => validate(current, { enableTrackingHours: false, afterHoursMode: "limited" }), invalid);
  assert.throws(() => validate({ ...current, enableTrackingHours: false }, { afterHoursMode: "limited" }), invalid);
  assert.throws(() => validate({ ...current, afterHoursMode: "limited" }, { enableTrackingHours: false }), invalid);
  assert.doesNotThrow(() => validate(current, { afterHoursMode: "limited" }));
  assert.doesNotThrow(() => validate({ ...current, afterHoursMode: "limited" }, { enableTrackingHours: false, afterHoursMode: "off" }));
});

test("merged enabled tracking window requires distinct valid times and configured days", () => {
  for (const patch of [{ trackingStartTime: "15:00" }, { trackingEndTime: "25:00" }, { trackingDays: [] }, { trackingDays: ["Funday"] }, { schoolTimezone: "No/Such_Zone" }]) assert.throws(() => validate(current, patch), invalid);
  assert.throws(() => validate({ ...current, trackingEndTime: "08:00" }, { afterHoursMode: "limited" }), invalid);
  assert.throws(() => validate({ ...current, trackingDays: null }, { afterHoursMode: "limited" }), invalid);
  assert.doesNotThrow(() => validate(current, { trackingStartTime: "22:00", trackingEndTime: "06:00", afterHoursMode: "limited" }));
  assert.doesNotThrow(() => validate(undefined, { enableTrackingHours: true, afterHoursMode: "limited" }));
});

test("unrelated settings saves preserve legacy policy without validating or changing it", () => {
  const legacy = { enableTrackingHours: false, afterHoursMode: "limited", trackingStartTime: null, trackingDays: [] };
  assert.doesNotThrow(() => validate(legacy, { schoolName: "Renamed", retentionHours: "24" }));
  assert.doesNotThrow(() => validate(legacy, { afterHoursMode: undefined }));
  assert.throws(() => validate(legacy, { afterHoursMode: "limited" }), invalid);
});

test("monitoring timezone follows the school profile and divergent writes reject", () => {
  assert.doesNotThrow(() => validateTimezone("America/Chicago", {}));
  assert.doesNotThrow(() => validateTimezone("America/Chicago", { schoolTimezone: "America/Chicago" }));
  assert.throws(() => validateTimezone("America/Chicago", { schoolTimezone: "America/New_York" }), { code: "CLASSPILOT_SCHOOL_TIMEZONE_READ_ONLY", status: 400 });
  assert.doesNotThrow(() => validateTimezone(null, { schoolTimezone: "America/New_York" }));
});
