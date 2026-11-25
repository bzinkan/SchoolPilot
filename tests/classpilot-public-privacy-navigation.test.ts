import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL("../" + path, import.meta.url), "utf8");
}

test("public navigation retains privacy and sends bookmarked disclosure links directly there", () => {
  const app = source("schoolpilot-app/src/App.jsx");
  assert.match(app, /path="\/ai-transparency"\s+element=\{<Navigate to="\/privacy" replace\s*\/>\}/);
  assert.doesNotMatch(app, /import\(.*AITransparency/);
  for (const path of ["pages/Landing.jsx", "pages/products/ClassPilotLanding.jsx", "pages/legal/PrivacyPolicy.jsx", "pages/legal/Subprocessors.jsx", "pages/legal/securityPosture.js"]) {
    assert.doesNotMatch(source("schoolpilot-app/src/" + path), /\/ai-transparency|AI Transparency|paused pending legal approval/i, path);
  }
});

test("privacy describes present local processing, historical data and the approved extension-data commitment", () => {
  const privacy = source("schoolpilot-app/src/pages/legal/PrivacyPolicy.jsx");
  const providers = source("schoolpilot-app/src/pages/legal/Subprocessors.jsx");
  const hecvat = source("docs/HECVAT-LITE.md");
  const text = privacy.replace(/<[^>]*>/g, "").replace(/\{" "\}/g, " ").replace(/\s+/g, " ");
  assert.match(text, /ClassPilot will follow the Chrome Web Store User Data Policy, including its Limited Use requirements, when handling extension data\./);
  assert.match(privacy, /href="https:\/\/developer\.chrome\.com\/docs\/webstore\/program-policies\/limited-use"/);
  assert.match(text, /local .*rules/i);
  assert.match(providers, /Gemini/);
  assert.match(providers, /Anthropic/);
  assert.match(providers, /500 characters/);
  assert.match(providers, /4,000 characters/);
  assert.match(providers, /OAuth, Workspace API, Classroom API/);
  assert.doesNotMatch(privacy + providers + hecvat, /during the pause|before the pause|pending legal approval|AI Transparency/i);
});

test("MailPilot screens accurately identify the absence of new scanning without a return announcement", () => {
  for (const path of ["EmailMonitoring.jsx", "EmailMonitoringSetup.jsx"]) {
    const text = source("schoolpilot-app/src/products/classpilot/pages/" + path).replace(/\s+/g, " ");
    assert.match(text, /new (?:Gmail |email )?messages? (?:are not|aren't) (?:analyzed|scanned)|does not (?:analyze|scan) new (?:Gmail |email )?messages/i);
    assert.doesNotMatch(text, /during the pause|before the pause|pending legal approval|once setup is complete|monitoring is active/i);
  }
});
