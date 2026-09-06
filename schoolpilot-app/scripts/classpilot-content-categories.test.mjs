import test from 'node:test';
import assert from 'node:assert/strict';
import { contentCategory,normalizeCategoryBreakdown } from '../src/products/classpilot/lib/contentCategories.js';
import { isStudentUrlOffTask } from '../src/products/classpilot/lib/dashboardCommandContext.js';
test('categories preserve off-task totals and keep unknown activity uncategorized',()=>{
  assert.equal(contentCategory('Gaming'),'Gaming');assert.equal(contentCategory('Invented label'),null);
  assert.deepEqual(normalizeCategoryBreakdown([{contentCategory:'Gaming',seconds:30},{contentCategory:null,seconds:10}],40),[{contentCategory:'Gaming',seconds:30},{contentCategory:null,seconds:10}]);
  assert.equal(normalizeCategoryBreakdown([{contentCategory:'Gaming',seconds:41}],40),null);
  assert.equal(normalizeCategoryBreakdown(null,40),null);
});
test('a content label never overrides teacher or school allowed-site intent',()=>{
  const student={activeTabUrl:'https://www.example.test/play',aiClassification:{category:'non-educational',contentCategory:'Gaming'}};
  assert.equal(isStudentUrlOffTask({student,teacherAllowedDomains:['example.test']}),false);
  assert.equal(isStudentUrlOffTask({student,schoolAllowedDomains:['example.test']}),false);
  assert.equal(isStudentUrlOffTask({student}),true);
});
