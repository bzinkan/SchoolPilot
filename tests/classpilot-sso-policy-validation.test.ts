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
  it("decodes reordered persisted defaults with fresh revisions and independent nested objects", () => {
    const input = disabledClasspilotSsoPolicy();
    const reordered = {
      profiles: input.profiles.map(profile => ({
        hostRules: profile.hostRules.map(rule => ({ includeSubdomains: rule.includeSubdomains, hostname: rule.hostname })),
        startUrl: profile.startUrl, name: profile.name, id: profile.id,
      })),
      attemptTtlSeconds: input.attemptTtlSeconds, defaultProfileId: input.defaultProfileId,
      enabled: input.enabled, schemaVersion: input.schemaVersion,
    };
    const first = classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: reordered, classpilotSsoPolicyRevision: 7 });
    assert.deepEqual(first, { policy: canonicalizeClasspilotSsoPolicy(reordered), revision: 7, valid: true });
    assert.notEqual(first.policy.profiles, reordered.profiles);
    assert.notEqual(first.policy.profiles[0]!.hostRules[0], reordered.profiles[0]!.hostRules[0]);
    first.policy.enabled = true;
    first.policy.profiles[0]!.name = "Changed";
    first.policy.profiles[0]!.hostRules[0]!.hostname = "evil.example.edu";
    first.policy.profiles[0]!.hostRules.push({ hostname: "other.example.edu", includeSubdomains: true });
    first.policy.profiles.pop();
    const next = classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: reordered, classpilotSsoPolicyRevision: 9 });
    assert.deepEqual(next, { policy: disabledClasspilotSsoPolicy(), revision: 9, valid: true });
    const invalidRevision = classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: reordered, classpilotSsoPolicyRevision: -1 });
    assert.equal(invalidRevision.revision, 0);
  });

  it("observes default-to-enabled-to-custom-to-default changes immediately", () => {
    const input = disabledClasspilotSsoPolicy();
    assert.equal(classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: input }).policy.enabled, false);
    input.enabled = true;
    assert.deepEqual(classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: input }), {
      policy: canonicalizeClasspilotSsoPolicy(input), revision: 0, valid: true,
    });
    const customized = { ...customPolicy({ startUrl: "https://LOGIN.EXAMPLE.EDU/district" }), enabled: false };
    assert.deepEqual(classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: customized, classpilotSsoPolicyRevision: 11 }), {
      policy: canonicalizeClasspilotSsoPolicy(customized), revision: 11, valid: true,
    });
    assert.deepEqual(classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: disabledClasspilotSsoPolicy(), classpilotSsoPolicyRevision: 12 }), {
      policy: disabledClasspilotSsoPolicy(), revision: 12, valid: true,
    });
  });

  it("keeps malformed near-default policies fail closed", () => {
    const base = disabledClasspilotSsoPolicy();
    const invalid: unknown[] = [
      { ...base, schemaVersion: 2 }, { ...base, enabled: "false" },
      { ...base, attemptTtlSeconds: 301 }, { ...base, unexpected: true },
      { schemaVersion: 1, enabled: false, defaultProfileId: "clever", profiles: base.profiles },
      { ...base, profiles: [base.profiles[0], base.profiles[0]] },
      { ...base, profiles: base.profiles.map(profile => ({ id: profile.id, startUrl: profile.startUrl, hostRules: profile.hostRules })) },
      { ...base, profiles: base.profiles.map(profile => ({ ...profile, hostRules: profile.hostRules.map(rule => ({ hostname: rule.hostname })) })) },
      { ...base, profiles: base.profiles.map(profile => ({ ...profile, startUrl: "https://evilclever.com/" })) },
      { ...base, profiles: base.profiles.map(profile => ({ ...profile, hostRules: profile.hostRules.map(rule => ({ ...rule, includeSubdomains: true })) })) },
      { ...base, profiles: base.profiles.map(profile => ({ ...profile, unexpected: true })) },
      { ...base, profiles: base.profiles.map(profile => ({ ...profile, hostRules: profile.hostRules.map(rule => ({ ...rule, unexpected: true })) })) },
    ];
    for (const policy of invalid) {
      assert.throws(() => canonicalizeClasspilotSsoPolicy(policy), ClasspilotSsoPolicyValidationError);
      assert.deepEqual(classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: policy, classpilotSsoPolicyRevision: 17 }), {
        policy: disabledClasspilotSsoPolicy(), revision: 17, valid: false,
      });
    }
    const throwing = new Proxy(base, { ownKeys() { throw new Error("Unreadable policy"); } });
    assert.equal(classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: throwing }).valid, false);
  });

  it("preserves an omitted default profile on a disabled persisted policy", () => {
    const base = disabledClasspilotSsoPolicy();
    const input = { schemaVersion: base.schemaVersion, enabled: false, attemptTtlSeconds: base.attemptTtlSeconds, profiles: base.profiles };
    const result = classpilotSsoPolicyFromSettings({ classpilotSsoPolicy: input, classpilotSsoPolicyRevision: 19 });
    assert.deepEqual(result, { policy: canonicalizeClasspilotSsoPolicy(input), revision: 19, valid: true });
    assert.equal(result.policy.defaultProfileId, null);
  });

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
