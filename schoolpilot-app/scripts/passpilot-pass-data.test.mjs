import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPassDuration,
  getCurrentSchoolWeekRange,
  getPassActualDurationMs,
  getPassDestinationLabel,
  getPassIssuerLabel,
  getPassStatusLabel,
} from "../src/products/passpilot/passData.js";
import { encodePassPilotCsv } from "../src/products/passpilot/passCsv.js";
import { startOfTodayInTimezone } from "../src/lib/date-utils.js";

test("school-local today starts at midnight independently of the device timezone", () => {
  const now = new Date("2026-08-19T15:00:00.000Z");
  assert.equal(
    startOfTodayInTimezone("America/New_York", now).toISOString(),
    "2026-08-19T04:00:00.000Z",
  );
  assert.equal(
    startOfTodayInTimezone("America/Los_Angeles", now).toISOString(),
    "2026-08-19T07:00:00.000Z",
  );
  assert.throws(
    () => startOfTodayInTimezone("America/New_York", new Date("invalid")),
    /valid Date/,
  );
});

test("current school week advances from Monday through the current weekday", () => {
  const wednesday = getCurrentSchoolWeekRange(
    "America/New_York",
    new Date("2026-08-19T15:00:00.000Z"),
  );
  assert.equal(wednesday.start.toISOString(), "2026-08-17T04:00:00.000Z");
  assert.equal(wednesday.end.toISOString(), "2026-08-19T15:00:00.000Z");
  assert.equal(wednesday.anchor, "2026-08-17");
  assert.equal(wednesday.label, "Aug 17–19, 2026");

  const monday = getCurrentSchoolWeekRange(
    "America/New_York",
    new Date("2026-08-17T13:30:00.000Z"),
  );
  assert.equal(monday.start.toISOString(), "2026-08-17T04:00:00.000Z");
  assert.equal(monday.end.toISOString(), "2026-08-17T13:30:00.000Z");
  assert.equal(monday.label, "Aug 17, 2026");

  const friday = getCurrentSchoolWeekRange(
    "America/New_York",
    new Date("2026-08-21T17:15:00.000Z"),
  );
  assert.equal(friday.start.toISOString(), "2026-08-17T04:00:00.000Z");
  assert.equal(friday.end.toISOString(), "2026-08-21T17:15:00.000Z");
  assert.equal(friday.label, "Aug 17–21, 2026");
});

test("weekend ranges stop at Friday night in the school timezone", () => {
  for (const now of ["2026-08-22T16:00:00.000Z", "2026-08-23T16:00:00.000Z"]) {
    const range = getCurrentSchoolWeekRange("America/New_York", new Date(now));
    assert.equal(range.start.toISOString(), "2026-08-17T04:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-08-22T03:59:59.999Z");
    assert.equal(range.anchor, "2026-08-17");
    assert.equal(range.label, "Aug 17–21, 2026");
  }
});

test("school-week boundaries are independent of the process timezone and DST-safe", () => {
  const dstWeekend = getCurrentSchoolWeekRange(
    "America/New_York",
    new Date("2026-11-01T17:00:00.000Z"),
  );
  assert.equal(dstWeekend.start.toISOString(), "2026-10-26T04:00:00.000Z");
  assert.equal(dstWeekend.end.toISOString(), "2026-10-31T03:59:59.999Z");
  assert.equal(dstWeekend.anchor, "2026-10-26");
  assert.equal(dstWeekend.label, "Oct 26–30, 2026");

  const fallback = getCurrentSchoolWeekRange(
    "Not/A_Timezone",
    new Date("2026-08-19T15:00:00.000Z"),
  );
  assert.equal(fallback.start.toISOString(), "2026-08-17T04:00:00.000Z");
  assert.throws(
    () => getCurrentSchoolWeekRange("America/New_York", new Date("invalid")),
    /valid Date/,
  );
});

test("actual duration accepts only valid returned passes", () => {
  const returned = {
    status: "returned",
    issuedAt: "2026-08-19T13:00:00.000Z",
    returnedAt: "2026-08-19T13:02:30.000Z",
  };
  assert.equal(getPassActualDurationMs(returned), 150_000);
  assert.equal(getPassActualDurationMs({
    ...returned,
    issuedAt: "2026-08-20T23:59:00.000Z",
    returnedAt: "2026-08-21T00:01:30.000Z",
  }), 150_000);
  assert.equal(getPassActualDurationMs({ ...returned, returnedAt: returned.issuedAt }), 0);
  assert.equal(getPassActualDurationMs({ ...returned, status: "active" }), null);
  assert.equal(getPassActualDurationMs({ ...returned, status: "expired" }), null);
  assert.equal(getPassActualDurationMs({ ...returned, status: "canceled" }), null);
  assert.equal(getPassActualDurationMs({ ...returned, returnedAt: "2026-08-19T12:59:00.000Z" }), null);
  assert.equal(getPassActualDurationMs({ ...returned, returnedAt: "not-a-date" }), null);
  assert.equal(getPassActualDurationMs({ ...returned, returnedAt: null }), null);
});

test("duration formatting rounds only a completed aggregate", () => {
  assert.equal(formatPassDuration(null), "—");
  assert.equal(formatPassDuration(Number.NaN), "—");
  assert.equal(formatPassDuration(-1), "—");
  assert.equal(formatPassDuration(0), "0 min");
  assert.equal(formatPassDuration(1), "<1 min");
  assert.equal(formatPassDuration(59_999), "<1 min");
  assert.equal(formatPassDuration(60_000), "1 min");
  assert.equal(formatPassDuration(89_999), "1 min");
  assert.equal(formatPassDuration(90_000), "2 min");
});

test("issuer, status, and destination labels cover teacher and kiosk history", () => {
  assert.equal(getPassIssuerLabel({ teacher: { name: "Brian Zinkan" }, issuedVia: "teacher" }), "Brian Zinkan");
  assert.equal(getPassIssuerLabel({ teacher: { displayName: "Brian Zinkan" }, issuedVia: "kiosk" }), "Brian Zinkan (Kiosk)");
  assert.equal(getPassIssuerLabel({ teacher: { name: "Brian Zinkan (Kiosk)" }, issuedVia: "kiosk" }), "Brian Zinkan (Kiosk)");
  assert.equal(getPassIssuerLabel({ teacherId: null, teacher: null, issuedVia: "kiosk" }), "Unattributed kiosk");
  assert.equal(getPassIssuerLabel({ teacherId: "former-id", teacher: null, issuedVia: "teacher" }), "Former staff member");
  assert.equal(getPassIssuerLabel({ teacherId: "former-id", teacher: null, issuedVia: "kiosk" }), "Former staff member (Kiosk)");
  assert.equal(getPassIssuerLabel({ teacherId: null, teacher: null, issuedVia: "teacher" }), "Unknown issuer");

  assert.equal(getPassStatusLabel({ status: "returned" }), "Returned");
  assert.equal(getPassStatusLabel({ status: "active" }), "Still out");
  assert.equal(getPassStatusLabel({ status: "expired" }), "Expired");
  assert.equal(getPassStatusLabel({ status: "canceled" }), "Canceled");
  assert.equal(getPassStatusLabel({ status: "cancelled" }), "Canceled");
  assert.equal(getPassStatusLabel({}), "Not returned");

  assert.equal(getPassDestinationLabel({ destination: "bathroom" }), "Bathroom");
  assert.equal(getPassDestinationLabel({ destination: "other_classroom" }), "Other Classroom");
  assert.equal(getPassDestinationLabel({ destination: "custom", customDestination: "Library" }), "Library");
  assert.equal(getPassDestinationLabel({ destination: "front_desk" }), "Front Desk");
  assert.equal(getPassDestinationLabel({}), "General");
});

test("PassPilot CSV exports quote fields and neutralize spreadsheet formulas", () => {
  const csv = encodePassPilotCsv([
    ["Student", "Destination", "Issued By"],
    ["=HYPERLINK(\"https://example.invalid\")", "  +1+1", "@SUM(A1:A2)"],
    ["-10", "ordinary, value", 'Name "Quoted"'],
  ]);

  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
  assert.match(csv, /"'  \+1\+1"/);
  assert.match(csv, /"'@SUM\(A1:A2\)"/);
  assert.match(csv, /"'-10"/);
  assert.match(csv, /"ordinary, value"/);
  assert.match(csv, /"Name ""Quoted"""/);
});
