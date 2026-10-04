import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const [milliseconds, ...args] = process.argv.slice(2), timeout = Number(milliseconds);
assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900_000);
assert.ok(args.length > 0);
// Bound only the owned local harness process, never a shared service or pool.
const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
let expired = false;
const watchdog = setTimeout(() => { expired = true; console.error('Owned fixture step exceeded its outer diagnostic deadline'); child.kill(); }, timeout);
child.once('error', error => { console.error(error.message); clearTimeout(watchdog); process.exitCode = 1; });
child.once('close', code => { clearTimeout(watchdog); process.exitCode = expired ? 1 : code ?? 1; });
