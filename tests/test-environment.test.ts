import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("fault fixtures cannot rehydrate external alert providers through dotenv and actual application imports", () => {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "schoolpilot-test-alerts-"));
  const fixturePath = join(directory, "fake-provider.env");
  writeFileSync(fixturePath, "SENDGRID_API_KEY=SG.fake-fixture-only\nTELEGRAM_BOT_TOKEN=fake-fixture-bot\nTELEGRAM_CHAT_ID=fake-fixture-chat\n");
  try {
    // Exercise the same compiled application entry used by the serving image.
    // CI builds first; this guard does not depend on a second TS loader startup.
    const result = spawnSync(process.execPath, [
      "--import", "./tests/test-environment.mjs", "--input-type=module", "-e", `
        const { default: dotenv } = await import('dotenv');
        dotenv.config({ path: process.env.TEST_ALERT_PROVIDER_ENV, quiet: true });
        await import('./dist/app.js');
        const { emailProviderConfigured } = await import('./dist/services/email.js');
        if (emailProviderConfigured() || process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_CHAT_ID)
          throw new Error('External alert provider escaped test isolation');
        const { default: monitor } = await import('./dist/services/errorMonitor.js');
        await monitor.disposeAndWait();
        const { pool, sessionPool } = await import('./dist/db.js');
        const { schedulerPool, schedulerLockPool } = await import('./dist/services/schedulerDb.js');
        await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
      `,
    ], {
      encoding: "utf8", timeout: 20_000,
      env: {
        ...process.env, NODE_ENV: "test", SCHEDULER_ENABLED: "false",
        DATABASE_URL: "postgresql://unused:unused@127.0.0.1:9/test_bootstrap",
        ADMIN_DATABASE_URL: "postgresql://unused:unused@127.0.0.1:9/test_bootstrap",
        DATABASE_URL_PRIVILEGED: "postgresql://unused:unused@127.0.0.1:9/test_bootstrap",
        TEST_REDIS_URL: "", JWT_SECRET: "test-bootstrap-only", SESSION_SECRET: "test-bootstrap-only",
        TEST_ALERT_PROVIDER_ENV: fixturePath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /SG\.fake-fixture-only|fake-fixture-bot|fake-fixture-chat/);
  } finally {
    const resolved = realpathSync(directory);
    assert.equal(dirname(resolved), temporaryRoot);
    assert.ok(basename(resolved).startsWith("schoolpilot-test-alerts-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
