import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("lifecycle control-state fanout stays inside exact student-binding authority", async () => {
  const [delivery, lifecycle] = await Promise.all([
    readFile(
      new URL("../src/services/classpilotControlStateDelivery.ts", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../src/services/classpilotSessionLifecycle.ts", import.meta.url),
      "utf8"
    ),
  ]);
  const sync = delivery.slice(
    delivery.indexOf("export async function syncClasspilotControlStatesToActiveDevices")
  );

  assert.match(
    sync,
    /const exactTarget = \{[\s\S]*kind: "student-binding" as const,[\s\S]*studentSessionId: session\.id,[\s\S]*deviceId: session\.deviceId/
  );
  assert.match(
    sync,
    /withClasspilotStudentControlDeliveryAuthority\([\s\S]*getClasspilotStudentControlState\([\s\S]*transactionDb[\s\S]*buildStudentFabState\([\s\S]*dbInstance: transactionDb/
  );
  assert.match(
    sync,
    /classpilotControlStateHasLateSignInOrigin\(state\.desiredState\)[\s\S]*isClasspilotCapabilityActive\([\s\S]*"lateSignInRestrictionSsoV1"[\s\S]*deferredOriginWithheld: true[\s\S]*if \(prepared\.deferredOriginWithheld\) \{[\s\S]*return \{ publications: authorizedPublications \}/
  );
  assert.match(
    sync,
    /requiredCapability = prepared\.lateSignInRequired[\s\S]*lateSignInRestrictionSsoV1[\s\S]*serializeClasspilotStudentControlStateForDelivery\([\s\S]*acceptedCapabilities: realtime\?\.acceptedCapabilities \?\? \[\][\s\S]*authPassThrough:[\s\S]*restrictionAuthPassThroughV1/
  );
  assert.match(
    sync,
    /classroomRequiredCapabilities = \[[\s\S]*requiredCapability[\s\S]*restrictionAuthPassThroughV1/
  );
  assert.match(
    sync,
    /if \(deliveredState\.classroomState && !deliveredState\.withheld\)[\s\S]*authorizedPublications\.push\(\{ target: classroomTarget, message: classroomMessage \}\)[\s\S]*classpilotFabStatePushFrame/,
    "auth-capability withholding must skip only the restriction and still converge FAB ownership",
  );
  assert.doesNotMatch(
    sync,
    /if \(!deliveredState\.classroomState \|\| deliveredState\.withheld\) \{[\s\S]*return \{ publications: authorizedPublications \}/,
  );
  assert.match(sync, /authorizedPublications\.push\(\{ target: classroomTarget, message: classroomMessage \}\)/);
  assert.match(sync, /authorizedPublications\.push\(\{ target: fabTarget, message: fabMessage \}\)/);
  assert.match(sync, /if \(!delivery\.authorized\) continue;[\s\S]*sendToStudentBindingLocal\(publication\.target/);
  const syncAuthorityCallback = sync.slice(
    sync.indexOf("(_claimed, prepared) =>"),
    sync.indexOf("if (!delivery.authorized) continue;")
  );
  assert.doesNotMatch(syncAuthorityCallback, /sendToStudentBindingLocal|publishWSBatch/);
  assert.doesNotMatch(sync, /sendToDeviceLocal|kind: "device"|CURRENT_URL/);

  const lifecycleRows = lifecycle.slice(
    lifecycle.indexOf("async function publishControlStateRows"),
    lifecycle.indexOf("export async function pushClasspilotSessionControlStates")
  );
  assert.match(
    lifecycleRows,
    /withClasspilotStudentControlDeliveryAuthority\([\s\S]*getClasspilotStudentControlState\([\s\S]*transactionDb/
  );
  assert.match(
    lifecycleRows,
    /current\.revision !== state\.revision[\s\S]*classpilotControlStateHasLateSignInOrigin\([\s\S]*current\.desiredState[\s\S]*isClasspilotCapabilityActive\([\s\S]*"lateSignInRestrictionSsoV1"/
  );
  assert.match(
    lifecycleRows,
    /requiredCapability = prepared\.lateSignInRequired[\s\S]*serializeClasspilotStudentControlStateForDelivery\([\s\S]*acceptedCapabilities: realtime\?\.acceptedCapabilities \?\? \[\][\s\S]*authPassThrough:[\s\S]*restrictionAuthPassThroughV1/
  );
  assert.match(
    lifecycleRows,
    /classroomRequiredCapabilities = \[[\s\S]*requiredCapability[\s\S]*restrictionAuthPassThroughV1/
  );
  assert.match(
    lifecycleRows,
    /if \(delivery\.authorized && delivery\.value\)[\s\S]*sendToStudentBindingLocal\(delivery\.value\.target/
  );
  const lifecycleAuthorityCallback = lifecycleRows.slice(
    lifecycleRows.indexOf("(_claimed, prepared) =>"),
    lifecycleRows.indexOf("if (delivery.authorized && delivery.value)")
  );
  assert.doesNotMatch(lifecycleAuthorityCallback, /sendToStudentBindingLocal|publishWS/);
  assert.match(
    lifecycleRows,
    /publishWS\(delivery\.value\.target, delivery\.value\.message\)/
  );
  assert.doesNotMatch(lifecycleRows, /sendToDeviceLocal|kind: "device"|CURRENT_URL/);
});
