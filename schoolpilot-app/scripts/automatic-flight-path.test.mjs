import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticFlightPathStopBody, automaticFlightPathBadge, automaticFlightPathPolicyKey, automaticFlightPathChoices } from '../src/products/classpilot/lib/automaticFlightPath.js';
import { teachingToolsQuery } from '../src/products/classpilot/lib/teachingTools.js';

test('turning off automatic restriction requires an exact class authority and revision', () => {
  assert.deepEqual(automaticFlightPathStopBody('session-a', 3), { teachingSessionId: 'session-a', targetScope: 'class', commandType: 'remove-flight-path', commandPayload: {}, stopAutomaticFlightPath: { expectedRevision: 3 } });
  for (const [session, revision] of [[null, 1], ['', 1], ['a', null], ['a', -1], ['a', 1.5]]) assert.throws(() => automaticFlightPathStopBody(session, revision));
});
test('status labels distinguish acknowledgements from pending, failures and manual overrides', () => {
  assert.equal(automaticFlightPathBadge({ status: 'applied', automatic: true }), 'Automatic · Applied');
  assert.equal(automaticFlightPathBadge({ status: 'pending', automatic: true }), 'Automatic · Pending');
  assert.equal(automaticFlightPathBadge({ status: 'failed' }), 'Automatic · Failed');
  assert.equal(automaticFlightPathBadge({ status: 'unavailable' }), 'Automatic · Unavailable');
  assert.equal(automaticFlightPathBadge({ status: 'overridden', automatic: false }), 'Manual override');
  assert.equal(automaticFlightPathBadge({ status: 'off' }), 'Automatic · Off');
  assert.equal(automaticFlightPathBadge({ status: 'status-unavailable' }), 'Automatic · Status unavailable');
  assert.equal(automaticFlightPathBadge({ status: 'unknown' }), null);
});
test('class preset cache is included in the existing school and viewer cleanup boundary', () => {
  const queryKey = automaticFlightPathPolicyKey('class-a', 'school-a', 'teacher-a');
  assert.equal(teachingToolsQuery({ queryKey }), true);
  assert.deepEqual(queryKey.slice(-2), ['school-a', 'teacher-a']);
});

test('only primary teachers can choose personal paths; other class managers need the enabled school library', () => {
  const paths = [{ id: 'private' }, { id: 'shared', visibility: 'school' }, { id: 'official', official: true }];
  assert.deepEqual(automaticFlightPathChoices(paths, { viewerId: 'primary', primaryTeacherId: 'primary', sharedPathsEnabled: true }), paths);
  assert.deepEqual(automaticFlightPathChoices(paths, { viewerId: 'admin', primaryTeacherId: 'primary', sharedPathsEnabled: true }).map(path => path.id), ['shared', 'official']);
  assert.deepEqual(automaticFlightPathChoices(paths, { viewerId: 'admin', primaryTeacherId: 'primary', sharedPathsEnabled: false }), []);
});
