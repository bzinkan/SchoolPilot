import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function page(filename: string) {
  return readFileSync(new URL("../schoolpilot-app/src/pages/" + filename, import.meta.url), "utf8");
}

test("the public footer links to AI Transparency without promoting active AI browsing protection", () => {
  const landing = page("Landing.jsx");
  assert.match(landing, /<footer[\s\S]*?href="\/ai-transparency"[^>]*>AI Transparency</);
  assert.doesNotMatch(landing, /AI-powered content classification to help keep students safe/i);
});

test("public browser disclosures identify the Gemini pause and distinguish reviewed rules from unfamiliar activity", () => {
  for (const name of ["legal/AITransparency.jsx", "legal/PrivacyPolicy.jsx", "legal/Subprocessors.jsx", "products/ClassPilotLanding.jsx"]) {
    const content = page(name).replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
    assert.match(content, /Gemini[^.]{0,150}paused pending legal approval|paused pending legal approval[^.]{0,150}Gemini/i, name);
    assert.doesNotMatch(content, /Schoolpilot uses Google's Gemini API|Google's Gemini API for this classification|together with Gemini classification/i, name);
  }
  const notice = page("legal/AITransparency.jsx").replace(/\s+/g, " ");
  assert.match(notice, /local (?:website and search |browser |classification )?rules/i);
  assert.match(notice, /unknown|unclassified/i);
  assert.match(page("legal/Subprocessors.jsx"), /OAuth, Workspace API, Classroom API/);
});

test("each public disclosure reports the external AI pause for both providers", () => {
  for (const name of ["legal/AITransparency.jsx", "legal/PrivacyPolicy.jsx", "legal/Subprocessors.jsx", "products/ClassPilotLanding.jsx"]) {
    const content = page(name).replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
    assert.match(content, /Anthropic[^.]{0,120}paused pending legal approval|paused pending legal approval[^.]{0,120}Anthropic/i, name);
    assert.doesNotMatch(content, /Schoolpilot (?:also )?uses Anthropic's API|when AI enrichment is enabled and available, send matching text/i, name);
  }
  const notice = page("legal/AITransparency.jsx").replace(/\s+/g, " ");
  assert.match(notice, /Google (?:sign-in|Workspace)/i);
  assert.match(notice, /existing (?:email )?alerts/i);
  assert.match(notice, /staff assistant[^.]{0,120}unavailable/i);
  const questionnaire = readFileSync(new URL("../docs/HECVAT-LITE.md", import.meta.url), "utf8");
  assert.match(questionnaire, /Gemini[^.]{0,100}Anthropic[^.]{0,100}paused pending legal approval/i);
});

test("connected and unconnected MailPilot screens identify the scanning pause", () => {
  for (const name of ["EmailMonitoring", "EmailMonitoringSetup"]) {
    const source = page("../products/classpilot/pages/" + name + ".jsx");
    assert.match(source, /Gmail safety scanning is paused pending legal approval/i, name);
    assert.doesNotMatch(source, /Protect students with AI-powered Gmail safety scanning|runs automatically once setup is complete|Monitoring is active|monitoring scans every student/i, name);
  }
});
