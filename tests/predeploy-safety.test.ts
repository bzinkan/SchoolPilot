import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("pre-deploy safety fixes", () => {
  it("keeps liveness and public health cheap and before session handling", () => {
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const livezRoute = app.indexOf('app.get("/livez"');
    const healthRoute = app.indexOf('app.get("/health"');
    const webSession = app.indexOf("const webSession = session");
    const detailedGate = app.indexOf("if (!detailed)");
    const detailedProbe = app.indexOf("const snapshot = await buildMonitoringHealthSnapshot", healthRoute);

    assert.ok(livezRoute > -1, "/livez route should exist");
    assert.ok(healthRoute > -1, "/health route should exist");
    assert.ok(livezRoute < webSession, "/livez should run before web-session middleware");
    assert.ok(healthRoute < webSession, "/health should run before web-session middleware");
    assert.ok(detailedGate < detailedProbe, "public /health should return before detailed probes");
    assert.doesNotMatch(app, /runLivenessDbProbe|LIVEZ_DB_TIMEOUT_MS|pool\.query\("SELECT 1"\)/);
  });

  it("keeps public synthetic checks on /health and not public /livez", () => {
    const cdn = readFileSync(new URL("../infra/modules/cdn/main.tf", import.meta.url), "utf8");
    const alarms = readFileSync(new URL("../infra/alarms.tf", import.meta.url), "utf8");

    assert.doesNotMatch(cdn, /path_pattern\s+=\s+"\/livez"/);
    assert.match(cdn, /path_pattern\s+=\s+"\/health"/);
    assert.match(alarms, /resource_path\s+=\s+"\/health"/);
    assert.doesNotMatch(alarms, /resource_path\s+=\s+"\/livez"/);
  });

  it("uses a partial concurrent purge index for evidence screenshots", () => {
    const startup = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const schema = readFileSync(new URL("../src/schema/shared.ts", import.meta.url), "utf8");

    assert.match(startup, /DROP INDEX CONCURRENTLY IF EXISTS evidence_artifacts_artifact_captured_idx/);
    assert.match(
      startup,
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS evidence_artifacts_purge_idx ON evidence_artifacts \(captured_at\) WHERE artifact_type = 'screenshot' AND content IS NOT NULL/
    );
    assert.match(schema, /index\("evidence_artifacts_purge_idx"\)/);
    assert.match(schema, /artifact_type = 'screenshot' AND content IS NOT NULL/);
  });
});
