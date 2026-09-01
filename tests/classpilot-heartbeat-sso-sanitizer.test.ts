import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classpilotSsoPolicyApprovesObservedUrl,
  sanitizeClasspilotHeartbeatNavigationForSso,
} from "../src/services/classpilotHeartbeatSsoSanitizer.js";
import type { ClasspilotSsoPolicy } from "../src/services/classpilotSsoPolicy.js";

const policy: ClasspilotSsoPolicy = {
  schemaVersion: 1,
  enabled: true,
  defaultProfileId: "clever",
  attemptTtlSeconds: 300,
  profiles: [{
    id: "clever",
    name: "Clever",
    startUrl: "https://clever.com/in/example",
    hostRules: [
      { hostname: "clever.com", includeSubdomains: true },
      { hostname: "accounts.google.com", includeSubdomains: false },
    ],
  }],
};

test("approved SSO heartbeat telemetry is reduced to origin-only neutral data", () => {
  assert.deepEqual(sanitizeClasspilotHeartbeatNavigationForSso({
    activeTabUrl: "https://accounts.google.com/o/oauth2/v2/auth?token=secret#fragment",
    activeTabTitle: "Student account name",
    favicon: "data:image/png;base64,secret",
    policy,
  }), {
    activeTabUrl: "https://accounts.google.com",
    activeTabTitle: "Signing in",
    favicon: null,
    authHostMatched: true,
  });
  assert.deepEqual(
    sanitizeClasspilotHeartbeatNavigationForSso({
      activeTabUrl: "https://district.clever.com/oauth/callback?code=secret",
      activeTabTitle: "Clever callback",
      favicon: "https://district.clever.com/icon.png",
      allOpenTabs: [{
        url: "https://accounts.google.com/signin/oauth?code=tab-secret",
        title: "Student account",
        favicon: "data:image/png;base64,tab-secret",
        active: false,
      }],
      policy,
    }),
    {
      activeTabUrl: "https://district.clever.com",
      activeTabTitle: "Signing in",
      favicon: null,
      allOpenTabs: [{
        url: "https://accounts.google.com",
        title: "Signing in",
        favicon: null,
        active: false,
      }],
      authHostMatched: true,
    }
  );
});

test("exact/subdomain matching rejects lookalikes and unapproved Google hosts", () => {
  for (const activeTabUrl of [
    "https://evilclever.com/login?token=preserved-for-ordinary-telemetry",
    "https://accounts.google.com.evil.test/login?token=ordinary",
    "https://classroom.google.com/u/0/c/example",
    "http://accounts.google.com/login?token=ordinary",
  ]) {
    const result = sanitizeClasspilotHeartbeatNavigationForSso({
      activeTabUrl,
      activeTabTitle: "Ordinary title",
      favicon: "ordinary-icon",
      policy,
    });
    assert.equal(result.authHostMatched, false);
    assert.equal(result.activeTabUrl, activeTabUrl);
    assert.equal(result.activeTabTitle, "Ordinary title");
    assert.equal(result.favicon, "ordinary-icon");
  }
});

test("configured provider hosts stay private while policy is disabled", () => {
  const url = "https://accounts.google.com./login?code=secret";
  const disabledResult = sanitizeClasspilotHeartbeatNavigationForSso({
    activeTabUrl: url,
    activeTabTitle: "Account",
    favicon: "data:image/png;base64,secret",
    policy: { ...policy, enabled: false, defaultProfileId: null },
  });
  assert.deepEqual(disabledResult, {
    activeTabUrl: "https://accounts.google.com",
    activeTabTitle: "Signing in",
    favicon: null,
    authHostMatched: true,
  });
  assert.equal(sanitizeClasspilotHeartbeatNavigationForSso({
    activeTabUrl: url,
    activeTabTitle: "Account",
    favicon: null,
    policy,
  }).activeTabUrl, "https://accounts.google.com");
});

test("current-page persistence can reject approved authentication URLs", () => {
  assert.equal(classpilotSsoPolicyApprovesObservedUrl(
    "https://district.clever.com/oauth/callback?code=secret",
    policy,
  ), true);
  assert.equal(classpilotSsoPolicyApprovesObservedUrl(
    "https://evilclever.com/oauth/callback?code=ordinary",
    policy,
  ), false);
  assert.equal(classpilotSsoPolicyApprovesObservedUrl(
    "http://accounts.google.com/login",
    policy,
  ), false);
  assert.equal(classpilotSsoPolicyApprovesObservedUrl(
    "https://accounts.google.com/login",
    { ...policy, enabled: false, defaultProfileId: null },
  ), true);
});

test("current-page delivery re-evaluates a newer administrator SSO policy", () => {
  const observedUrl = "https://login.district-idp.example/oauth/callback?code=secret";
  const policyAtObservation: ClasspilotSsoPolicy = {
    schemaVersion: 1,
    enabled: false,
    defaultProfileId: null,
    attemptTtlSeconds: 300,
    profiles: [],
  };
  const policyAtExactDelivery: ClasspilotSsoPolicy = {
    schemaVersion: 1,
    enabled: true,
    defaultProfileId: "district-idp",
    attemptTtlSeconds: 300,
    profiles: [{
      id: "district-idp",
      name: "District IdP",
      startUrl: "https://login.district-idp.example/start",
      hostRules: [{
        hostname: "login.district-idp.example",
        includeSubdomains: false,
      }],
    }],
  };

  assert.equal(
    classpilotSsoPolicyApprovesObservedUrl(observedUrl, policyAtObservation),
    false,
    "the URL is initially eligible when no authentication host is configured",
  );
  assert.equal(
    classpilotSsoPolicyApprovesObservedUrl(observedUrl, policyAtExactDelivery),
    true,
    "the same process-local URL becomes ineligible when the locked delivery policy changes",
  );
});

test("OAuth callback telemetry is redacted while an authentication flow is returning", () => {
  const result = sanitizeClasspilotHeartbeatNavigationForSso({
    activeTabUrl: "https://classroom.google.com/u/0/c/example?code=secret&state=opaque",
    activeTabTitle: "Student Classroom",
    favicon: "data:image/png;base64,secret",
    allOpenTabs: [{
      url: "https://classroom.google.com/u/0/c/example?code=tab-secret",
      title: "Callback",
      favicon: "secret-icon",
    }, {
      url: "https://example.edu/search?q=ordinary",
      title: "Ordinary query",
      favicon: "ordinary-icon",
    }],
    policy,
    restrictionAuthState: "returning",
  });
  assert.deepEqual(result, {
    activeTabUrl: "https://classroom.google.com/u/0/c/example",
    activeTabTitle: "Signing in",
    favicon: null,
    allOpenTabs: [{
      url: "https://classroom.google.com/u/0/c/example",
      title: "Signing in",
      favicon: null,
    }, {
      url: "https://example.edu/search?q=ordinary",
      title: "Ordinary query",
      favicon: "ordinary-icon",
    }],
    authHostMatched: true,
  });

  const idle = sanitizeClasspilotHeartbeatNavigationForSso({
    activeTabUrl: "https://classroom.google.com/u/0/c/example?code=ordinary-after-flow",
    activeTabTitle: "Classroom",
    favicon: "icon",
    policy,
    restrictionAuthState: "idle",
  });
  assert.equal(idle.authHostMatched, false);
  assert.equal(
    idle.activeTabUrl,
    "https://classroom.google.com/u/0/c/example?code=ordinary-after-flow"
  );

  const restartBeforeAuthRestore = sanitizeClasspilotHeartbeatNavigationForSso({
    activeTabUrl: "https://classroom.google.com/u/0/c/example?code=restart-secret&state=opaque",
    activeTabTitle: "Student account callback",
    favicon: "secret-icon",
    policy,
    restrictionAuthState: "idle",
    authRelevantRestrictionActive: true,
  });
  assert.deepEqual(restartBeforeAuthRestore, {
    activeTabUrl: "https://classroom.google.com/u/0/c/example",
    activeTabTitle: "Signing in",
    favicon: null,
    authHostMatched: true,
  });
});

test("heartbeat route applies callback privacy before heartbeat persistence", () => {
  const devices = readFileSync(
    new URL("../src/routes/classpilot/devices.ts", import.meta.url),
    "utf8"
  );
  const sanitizeAt = devices.indexOf("sanitizeClasspilotHeartbeatNavigationForSso({");
  const persistAt = devices.indexOf("createHeartbeatAndRefreshPresence({", sanitizeAt);
  assert.ok(sanitizeAt >= 0 && persistAt > sanitizeAt);
  const call = devices.slice(sanitizeAt, persistAt);
  assert.match(call, /restrictionAuthState/);
  assert.match(
    call,
    /authRelevantRestrictionActive:[\s\S]*classpilotControlStateHasAuthRelevantRestriction/,
  );
});
