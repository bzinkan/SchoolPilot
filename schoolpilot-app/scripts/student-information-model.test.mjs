import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactChanges, emptyContact, sourceContactDecision } from '../src/products/classpilot/lib/studentInformationModel.js';
test('contact editor preserves strings, recognizes exact no-op and distinguishes explicit erasure',()=>{
  const contact={...emptyContact(),name:'Synthetic Guardian',phones:['00123'],emails:['guardian@example.invalid']};
  assert.deepEqual(contactChanges({contacts:[contact]},{contacts:[structuredClone(contact)]}),[]);
  const edited={...contact,phones:[]};assert.deepEqual(contactChanges({contacts:[contact]},{contacts:[edited]}),[{kind:'replace',contactId:contact.id,fields:{},clearFields:['phones']}]);
  assert.deepEqual(sourceContactDecision(contact,{kind:'keep'}),null);
  assert.equal(sourceContactDecision(contact,{kind:'add'}).contact.phones[0],'00123');
  assert.throws(()=>sourceContactDecision(contact,{kind:'replace'}));
});
