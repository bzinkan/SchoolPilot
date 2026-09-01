import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ClasspilotSsoPolicyValidationError,
  builtInClasspilotSsoProfiles,
  canonicalizeClasspilotSsoPolicy,
  classpilotSsoPolicyFromSettings,
  disabledClasspilotSsoPolicy,
  findClasspilotSsoPolicyBlockConflicts,
} from "../src/services/classpilotSsoPolicy.ts";

function customPolicy(profile: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultProfileId: "custom",
    attemptTtlSeconds: 300,
    profiles: [{
      id: "custom",
      name: "District identity provider",
      startUrl: "https://login.example.edu/start",
      hostRules: [{ hostname: "login.example.edu", includeSubdomains: false }],
      ...profile,
    }],
  };
}

function assertInvalid(policy: unknown, expectedCode?: string) {
  assert.throws(
    () => canonicalizeClasspilotSsoPolicy(policy),
    (error: unknown) => {
      assert.ok(error instanceof ClasspilotSsoPolicyValidationError);
      if (expectedCode) {
        assert.ok(error.issues.some((issue) => issue.code === expectedCode), JSON.stringify(error.issues));
      }
      return true;
    }
  );
}

describe("ClassPilot SSO policy validation", () => {
  it("canonicalizes a bounded HTTPS provider and retains a necessary query string", () => {
    const result = canonicalizeClasspilotSsoPolicy(customPolicy({
      startUrl: "https://Login.Example.Edu/start?district=alpha",
      hostRules: [{ hostname: "LOGIN.EXAMPLE.EDU", includeSubdomains: false }],
    }));
    assert.equal(result.attemptTtlSeconds, 300);
    assert.equal(result.profiles[0]?.startUrl, "https://login.example.edu/start?district=alpha");
    assert.deepEqual(result.profiles[0]?.hostRules, [
      { hostname: "login.example.edu", includeSubdomains: false },
    ]);
  });

  it("rejects HTTP, credentials, fragments, non-default ports, IPs, localhost, and public suffixes", () => {
    const cases: Array<[unknown, string]> = [
      [customPolicy({ startUrl: "http://login.example.edu/start" }), "invalid_url"],
      [customPolicy({ startUrl: "https://student:secret@login.example.edu/start" }), "invalid_url"],
      [customPolicy({ startUrl: "https://login.example.edu/start#access_token" }), "invalid_url"],
      [customPolicy({ startUrl: "https://login.example.edu:444/start" }), "invalid_url"],
      [customPolicy({
        startUrl: "https://127.0.0.1/start",
        hostRules: [{ hostname: "127.0.0.1", includeSubdomains: false }],
      }), "invalid_hostname"],
      [customPolicy({
        startUrl: "https://localhost/start",
        hostRules: [{ hostname: "localhost", includeSubdomains: false }],
      }), "invalid_hostname"],
      [customPolicy({
        startUrl: "https://co.uk/start",
        hostRules: [{ hostname: "co.uk", includeSubdomains: true }],
      }), "public_suffix"],
    ];
    for (const [policy, code] of cases) assertInvalid(policy, code);
  });

  it("rejects trailing dots, wildcards, malformed IDNs, duplicates, and lookalikes", () => {
    const cases: Array<[unknown, string]> = [
      [customPolicy({
        startUrl: "https://login.example.edu./start",
        hostRules: [{ hostname: "login.example.edu.", includeSubdomains: false }],
      }), "invalid_hostname"],
      [customPolicy({ hostRules: [{ hostname: "*.example.edu", includeSubdomains: true }] }), "invalid_hostname"],
      [customPolicy({
        startUrl: "https://accounts.google.com/",
        hostRules: [{ hostname: "accounts.google.com", includeSubdomains: true }],
      }), "google_accounts_must_be_exact"],
      [customPolicy({ hostRules: [{ hostname: "\ud800.example.edu", includeSubdomains: false }] }), "invalid_hostname"],
      [customPolicy({
        startUrl: "https://g\u043e\u043egle.com/",
        hostRules: [{ hostname: "g\u043e\u043egle.com", includeSubdomains: false }],
      }), "invalid_hostname"],
      [customPolicy({
        startUrl: "https://\u0441lever.com/",
        hostRules: [{ hostname: "\u0441lever.com", includeSubdomains: false }],
      }), "invalid_hostname"],
      [customPolicy({
        startUrl: "https://xn--ggle-55da.com/",
        hostRules: [{ hostname: "xn--ggle-55da.com", includeSubdomains: false }],
      }), "invalid_hostname"],
      [customPolicy({
        startUrl: "https://xn--lever-0ye.com/",
        hostRules: [{ hostname: "xn--lever-0ye.com", includeSubdomains: false }],
      }), "invalid_hostname"],
      [customPolicy({
        startUrl: "https://evilclever.com/",
        hostRules: [{ hostname: "evilclever.com", includeSubdomains: false }],
      }), "provider_lookalike"],
      [customPolicy({
        startUrl: "https://accounts.google.com.evil.test/",
        hostRules: [{ hostname: "accounts.google.com.evil.test", includeSubdomains: false }],
      }), "provider_lookalike"],
      [customPolicy({ hostRules: [
        { hostname: "login.example.edu", includeSubdomains: false },
        { hostname: "LOGIN.EXAMPLE.EDU", includeSubdomains: false },
      ] }), "duplicate_host_rule"],
      [{
        ...customPolicy({}),
        profiles: [
          customPolicy({}).profiles[0],
          { ...customPolicy({}).profiles[0], name: "Duplicate", startUrl: "https://login.example.edu/other" },
        ],
      }, "duplicate_profile_id"],
      [{
        ...customPolicy({}),
        defaultProfileId: "google",
        profiles: [{
          id: "google",
          name: "Google lookalike",
          startUrl: "https://accounts.google.com.evil.test/",
          hostRules: [{ hostname: "accounts.google.com.evil.test", includeSubdomains: false }],
        }],
      }, "invalid_google_profile"],
      [{
        ...customPolicy({}),
        defaultProfileId: "clever",
        profiles: [{
          id: "clever",
          name: "Clever lookalike",
          startUrl: "https://evilclever.com/",
          hostRules: [
            { hostname: "evilclever.com", includeSubdomains: true },
            { hostname: "accounts.google.com", includeSubdomains: false },
          ],
        }],
      }, "invalid_clever_profile"],
    ];
    for (const [policy, code] of cases) assertInvalid(policy, code);
  });

  it("keeps built-ins exact, fails malformed persistence closed, and reports block conflicts", () => {
    const builtIns = builtInClasspilotSsoProfiles();
    assert.deepEqual(builtIns.find((profile) => profile.id === "google")?.hostRules, [
      { hostname: "accounts.google.com", includeSubdomains: false },
    ]);
    assert.deepEqual(
      builtIns.find((profile) => profile.id === "clever")?.hostRules,
      [
        { hostname: "accounts.google.com", includeSubdomains: false },
        { hostname: "clever.com", includeSubdomains: true },
      ]
    );

    const failedClosed = classpilotSsoPolicyFromSettings({
      classpilotSsoPolicy: { enabled: true },
      classpilotSsoPolicyRevision: 17,
    });
    assert.equal(failedClosed.valid, false);
    assert.equal(failedClosed.policy.enabled, false);
    assert.equal(failedClosed.revision, 17);

    const conflicts = findClasspilotSsoPolicyBlockConflicts(
      disabledClasspilotSsoPolicy(),
      ["accounts.google.com", "auth.clever.com"]
    );
    assert.ok(conflicts.some((conflict) => conflict.hostname === "accounts.google.com"));
    assert.ok(conflicts.some((conflict) => conflict.hostname === "clever.com"));
  });
});
