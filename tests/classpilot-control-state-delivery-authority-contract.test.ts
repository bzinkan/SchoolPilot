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
    /requiredCapability = prepared\.lateSignInRequired[\s\S]*lateSignInRestrictionSsoV1[\s\S]*deliveryTarget = requiredCapability[\s\S]*serializeClasspilotStudentControlStateForDelivery\([\s\S]*acceptedCapabilities: requiredCapability \? \[requiredCapability\] : \[\]/
  );
  assert.equal(
    sync.match(/sendToStudentBindingLocal\(deliveryTarget, (?:classroomMessage|fabMessage), \{ requiredCapability \}\)/g)?.length,
    2
  );
  assert.match(sync, /authorizedPublications\.push\(\{ target: deliveryTarget, message: classroomMessage \}\)/);
  assert.match(sync, /authorizedPublications\.push\(\{ target: deliveryTarget, message: fabMessage \}\)/);
  assert.match(sync, /if \(!delivery\.authorized\) continue;[\s\S]*authorizedTargets \+= 1/);
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
    /requiredCapability = prepared\.lateSignInRequired[\s\S]*deliveryTarget = requiredCapability[\s\S]*serializeClasspilotStudentControlStateForDelivery\([\s\S]*acceptedCapabilities: requiredCapability \? \[requiredCapability\] : \[\]/
  );
  assert.match(
    lifecycleRows,
    /sendToStudentBindingLocal\(deliveryTarget, message, \{ requiredCapability \}\)/
  );
  assert.match(
    lifecycleRows,
    /publishWS\(delivery\.value\.target, delivery\.value\.message\)/
  );
  assert.doesNotMatch(lifecycleRows, /sendToDeviceLocal|kind: "device"|CURRENT_URL/);
});
