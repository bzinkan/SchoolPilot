import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function canonicalSchemaFingerprint(ddl) {
  // pg_dump16 adds a fresh security nonce per dump. It is not database schema.
  // Retain every SQL statement, table/function name and dump version marker.
  const canonical = ddl.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
    .filter(line => !/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line)).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(canonicalSchemaFingerprint(readFileSync(process.argv[2], 'utf8')));
