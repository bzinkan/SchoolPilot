import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAutomaticFlightPathStopOption } from "../src/services/classpilotAutomaticFlightPathCommand.js";

const stop = { teachingSessionId: "session", targetScope: "class", commandType: "remove-flight-path", commandPayload: {},
  stopAutomaticFlightPath: { expectedRevision: 1 } };

test("only an explicit whole-class automatic removal qualifies for cleanup", () => {
  assert.deepEqual(parseAutomaticFlightPathStopOption(stop), { expectedRevision: 1 });
  for (const ordinary of [undefined, null, {}, { ...stop, stopAutomaticFlightPath: undefined }]) {
    if (ordinary && Object.hasOwn(ordinary, "stopAutomaticFlightPath"))
      assert.throws(() => parseAutomaticFlightPathStopOption(ordinary));
    else assert.equal(parseAutomaticFlightPathStopOption(ordinary), undefined);
  }
  assert.equal(parseAutomaticFlightPathStopOption({ commandType: "apply-flight-path", commandPayload: {} }), undefined);
});

test("cleanup never broadens missing authority, student selection, or an invented payload", () => {
  const invalid = [
    { teachingSessionId: "" }, { supervisionContextId: "context" }, { targetScope: "students" },
    { targetStudentIds: [] }, { subgroupId: null }, { deviceId: "private-route" },
    { commandType: "apply-flight-path" }, { commandPayload: { flightPathId: "path" } },
    { commandPayload: undefined }, { stopAutomaticFlightPath: true },
    { stopAutomaticFlightPath: { expectedRevision: -1 } }, { stopAutomaticFlightPath: { expectedRevision: 1, enabled: true } },
  ];
  for (const extra of invalid) assert.throws(() => parseAutomaticFlightPathStopOption({ ...stop, ...extra }),
    (error: any) => error.status === 400 && error.code === "AUTOMATIC_FLIGHT_PATH_STOP_INVALID");
});
