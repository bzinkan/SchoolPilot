import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { splitMessageLinks } from '../src/products/classpilot/lib/messageLinks.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/message-links.json', import.meta.url), 'utf8'));

for (const fixture of fixtures) {
  test(`message links: ${fixture.name}`, () => {
    const parts = splitMessageLinks(fixture.text);
    assert.equal(parts.map(part => part.text).join(''), fixture.text, 'Every original character must remain visible');
    assert.deepEqual(parts.filter(part => part.href).map(({ text, href }) => ({ text, href })), fixture.links);
  });
}
