import assert from 'node:assert/strict';
const KEY=Symbol.for('schoolpilot.external.ownedRoleCoordinator.v1');
export function getOwnedRoleCoordinator(){assert.ok(globalThis[KEY]);return globalThis[KEY];}
export function installOwnedRoleCoordinator(owner){assert.equal(globalThis[KEY],undefined);globalThis[KEY]=owner;return()=>{assert.equal(globalThis[KEY],owner);delete globalThis[KEY];};}
