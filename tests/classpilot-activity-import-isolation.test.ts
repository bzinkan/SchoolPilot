import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("shared GoPilot storage imports do not open scheduled classroom Redis connections", () => {
  const probe = `
    import assert from 'node:assert/strict';
    import { Socket } from 'node:net';
    let connections = 0;
    Socket.prototype.connect = function () {
      connections += 1;
      throw new Error('Network access is forbidden in the import isolation probe');
    };
    await import('./src/services/storage.ts');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connections, 0, 'Shared storage must not activate unrelated Redis clients');
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://import_probe:import_probe@127.0.0.1:1/import_probe",
      REDIS_URL: "redis://127.0.0.1:1",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
