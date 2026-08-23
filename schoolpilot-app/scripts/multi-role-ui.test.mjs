import assert from 'node:assert/strict';
import test from 'node:test';
import {
  goPilotMembershipRoles,
  hasGoPilotRole,
  hasMembershipRole,
  membershipRoles,
  primaryMembershipRole,
} from '../src/shared/utils/schoolRoles.js';

test('web authorization uses every canonical active role while preserving display role', () => {
  const membership = {
    role: 'office_staff',
    primaryRole: 'office_staff',
    roles: ['teacher', 'office_staff'],
  };
  assert.deepEqual(membershipRoles(membership), ['office_staff', 'teacher']);
  assert.equal(primaryMembershipRole(membership), 'office_staff');
  assert.equal(hasMembershipRole(membership, 'teacher'), true);
  assert.equal(hasMembershipRole(membership, 'admin', 'school_admin'), false);
});

test('GoPilot product roles remain deterministic and do not depend on row order', () => {
  const first = {
    role: 'teacher',
    roles: ['teacher', 'office_staff'],
    gopilotRole: 'office_staff',
    gopilotRoles: ['teacher', 'office_staff'],
  };
  const reversed = { ...first, gopilotRoles: [...first.gopilotRoles].reverse() };
  assert.deepEqual(goPilotMembershipRoles(first), ['office_staff', 'teacher']);
  assert.deepEqual(goPilotMembershipRoles(reversed), ['office_staff', 'teacher']);
  assert.equal(hasGoPilotRole(first, 'teacher'), true);
  assert.equal(hasGoPilotRole(first, 'office_staff'), true);
});

test('legacy single-role identity stays compatible', () => {
  assert.deepEqual(membershipRoles({ role: 'teacher' }), ['teacher']);
  assert.deepEqual(goPilotMembershipRoles({ role: 'teacher' }), ['teacher']);
});
