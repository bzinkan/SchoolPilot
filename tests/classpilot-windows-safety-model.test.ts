import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsBrowserEvidenceEligible } from "../src/services/classpilotWindowsSafetyModel.js";
test("only a fresh browser image from the same source, page and control revision may be evidence",()=>{
  const now=Date.parse("2026-10-29T00:00:00Z"),source={sourceRef:"opaque-source",bindingRevision:3,url:"https://school.example/lesson",controlRevision:8,observedAt:now};
  const image={sourceRef:source.sourceRef,bindingRevision:3,controlRevision:8,tabUrl:source.url,screenshot:"data:image/jpeg;base64,/9j/",screenshotAt:new Date(now).toISOString(),expiresAt:new Date(now+45_000).toISOString()};
  assert.equal(windowsBrowserEvidenceEligible(image,source,now),true);
  for(const changed of [{sourceRef:"other-browser"},{bindingRevision:2},{controlRevision:7},{tabUrl:"https://other.example/"},{screenshotAt:new Date(now-6000).toISOString()},{expiresAt:new Date(now).toISOString()}])assert.equal(windowsBrowserEvidenceEligible({...image,...changed},source,now),false);
  assert.equal(windowsBrowserEvidenceEligible(null,source,now),false);
  assert.equal(windowsBrowserEvidenceEligible({screenshot:image.screenshot,sourceGeneration:"native-source"},source,now),false,"native selected-source data has no browser authority");
});
