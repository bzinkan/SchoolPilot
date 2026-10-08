import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual after-hours function with synthetic storage dependencies;
// classification itself is the real service, with fetch intercepted at import.
const source = readFileSync(new URL("../src/services/classpilotAfterHoursSafety.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function processClasspilotAfterHoursSafety");
assert.ok(start >= 0);
const executable = ts.transpileModule(`${source.slice(start).replace("export async function", "async function")}\nprocessClasspilotAfterHoursSafety;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test("after-hours privacy withholding uses the real classifier and creates no alert or delivery action", async () => {
  const priorKey = process.env.GEMINI_API_KEY;
  const priorAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  let providerCalls = 0;
  process.env.GEMINI_API_KEY = "synthetic-after-hours-provider-key";
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("Withheld observations must not fetch"); };
  try {
    const { classifyUrl } = await import("../src/services/aiClassification.js");
    const observed: Array<[string, string | undefined]> = [];
    let schoolReads = 0;
    const context = {
      Date,
      crypto: { randomUUID: () => "synthetic-after-hours-source" },
      async runWithTenantContext(_scope: unknown, action: () => Promise<unknown>) { return action(); },
      async getSchoolById() { schoolReads += 1; return { domain: "school.example.invalid" }; },
      async classifyUrl(url: string, title: string | undefined, options: Parameters<typeof classifyUrl>[2]) {
        observed.push([url, title]);
        return classifyUrl(url, title, options);
      },
      withClasspilotStudentControlDeliveryAuthority() { assert.fail("No model-derived alert may reach delivery authority"); },
      getHeartbeatTrackingSettingsForSchool() { assert.fail("No alert or monitoring-policy change is permitted"); },
    };
    const processAfterHours: (options: {
      schoolId: string; studentId: string; studentSessionId: string; deviceId: string;
      url: string; title: string; acceptedCapabilities: readonly string[];
    }) => Promise<void> = runInNewContext(executable, context);
    const cases = [
      ["https://after-hours-private.test/lesson?token=SYNTHETIC_AFTER_HOURS_CREDENTIAL", "Synthetic lesson"],
      ["https://after-hours-private.test/lesson", "Lesson token=SYNTHETIC_AFTER_HOURS_TITLE_CREDENTIAL"],
    ] as const;
    for (const [url, title] of cases) {
      await assert.doesNotReject(processAfterHours({
        schoolId: "synthetic-school", studentId: "synthetic-student", studentSessionId: "synthetic-session",
        deviceId: "synthetic-device", url, title, acceptedCapabilities: [],
      }));
    }
    assert.equal(providerCalls, 0);
    assert.equal(schoolReads, cases.length);
    assert.deepEqual(observed, cases, "original navigation remains local; provider preparation does not rewrite it");
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
    if (priorAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorAnthropicKey;
  }
});
