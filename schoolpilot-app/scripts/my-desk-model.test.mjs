import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { myDeskKeys, buildMyDeskQuery, targetInput, validateMyDeskAttachment, schoolDate, clearMyDeskQueries } from '../src/products/classpilot/lib/myDeskModel.js';

test('private notebook cache separates schools, authors and attachment bytes', () => {
  assert.notDeepEqual(myDeskKeys.notes('school', 'alice', {}), myDeskKeys.notes('school', 'bob', {}));
  assert.notDeepEqual(myDeskKeys.attachment('a', 'alice', 'note', 'file'), myDeskKeys.attachment('b', 'alice', 'note', 'file'));
  const client = new QueryClient();
  client.setQueryData(myDeskKeys.notes('school', 'alice', {}), { notes: [{ body: 'private' }] });
  client.setQueryData(myDeskKeys.attachment('school', 'alice', 'note', 'file'), new Blob(['private']));
  client.setQueryData(['unrelated'], 'keep'); clearMyDeskQueries(client);
  assert.equal(client.getQueriesData({ queryKey: ['mydesk-private'] }).length, 0);
  assert.equal(client.getQueryData(['unrelated']), 'keep'); client.clear();
});

test('notebook filters use the strict API names without empty query values', () => {
  const params = new URLSearchParams(buildMyDeskQuery({ scope: 'class', classId: 'class-1', category: 'detention', studentId: '', q: '  remember  ', unknown: 'discard' }));
  assert.deepEqual(Object.fromEntries(params), { scope: 'class', classId: 'class-1', category: 'detention', q: 'remember' });
  assert.deepEqual(targetInput('general', 'old-class', 'old-student'), { targetKind: 'general' });
  assert.deepEqual(targetInput('student', 'class', 'student'), { targetKind: 'student', groupId: 'class', studentId: 'student' });
});

test('attachment validation and school-local dates match notebook constraints', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) assert.equal(validateMyDeskAttachment({ type, size: 100 }), '');
  assert.match(validateMyDeskAttachment({ type: 'image/heic', size: 100 }), /JPEG/);
  assert.match(validateMyDeskAttachment({ type: 'image/png', size: 10 * 1024 * 1024 + 1 }), /10 MiB/);
  assert.match(validateMyDeskAttachment({ type: 'application/pdf', size: 0 }), /empty/);
  assert.equal(schoolDate('America/New_York', new Date('2026-09-25T01:00:00Z')), '2026-09-24');
});
