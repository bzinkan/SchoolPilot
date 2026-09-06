import test from "node:test";
import assert from "node:assert/strict";
import { canonicalSafetyUrl,safetyUrlFingerprint,safetyAlertFingerprint,websiteFromSafetyUrl } from "../src/services/safetyUrl.js";

test("exact safety URL parsing preserves query order, duplicate parameters, fragments and scheme",()=>{
  const url='https://www.example.com:8443/a?b=2&a=1&a=3&utm_source=x#section';
  assert.equal(canonicalSafetyUrl(url),url);
  for(const variant of [url.replace('https:','http:'),url.replace('www.',''),url.replace('#section','#other'),url.replace('b=2&a=1','a=1&b=2'),url.replace('&utm_source=x',''),url.replace('/a?','/ab?')]){
    assert.notEqual(safetyUrlFingerprint('school',canonicalSafetyUrl(variant)!),safetyUrlFingerprint('school',url));
  }
  assert.equal(canonicalSafetyUrl('HTTPS://Example.COM:443'),'https://example.com/');
  assert.notEqual(safetyUrlFingerprint('school-a',url),safetyUrlFingerprint('school-b',url));
});
test("URL actions require an absolute retained browser URL",()=>{
  for(const input of ['javascript:alert(1)','file:///x','example.com/a','/a','https://user:password@example.com','data:text/plain,test','https://'])assert.equal(canonicalSafetyUrl(input),null);
  assert.equal(websiteFromSafetyUrl('https://www.example.com/a?x=1#part'),'www.example.com');
});
test("alert identity groups observations but separates concern, source and revocation generation",()=>{
  const key=safetyAlertFingerprint('s','browser:original','violence','https://example.com/','hb-1');
  assert.equal(key,safetyAlertFingerprint('s','browser:original','violence','https://example.com/','hb-2'));
  assert.notEqual(key,safetyAlertFingerprint('s','browser:revoked-rule','violence','https://example.com/','hb-2'));
  assert.notEqual(key,safetyAlertFingerprint('s','browser:original','self-harm','https://example.com/','hb-2'));
  assert.notEqual(safetyAlertFingerprint('s','mailpilot','bullying',null,'mail-1'),safetyAlertFingerprint('s','mailpilot','bullying',null,'mail-2'));
});
