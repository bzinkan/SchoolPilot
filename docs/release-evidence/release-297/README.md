# Focused release 2.9.7 validation records

[The manifest](focused-validation-5f406d8c.json) records exact commands, source
SHA, timestamps, exit codes, test/assertion counts, raw-log hashes, sanitized-log
hashes and the local schema scope. Its companion
[`focused-validation-5f406d8c.logs.ndjson.gz`](focused-validation-5f406d8c.logs.ndjson.gz)
contains 17 compact, sanitized log entries. It is gzip-compressed newline-delimited
JSON; each entry contains an `id` and the complete sanitized `utf8Log`.

The clean `5f406d8c59e0a72647b78ae9cd1faed4622eba50` checkpoint passed:

- 19 real PostgreSQL reference/coverage cases and seven usage cases using a
  restricted, non-owner, non-bypass application role, with no skips.
- 45 deployment/image/admission tests and 29 pure workload guards.
- 1,284 ClassPilot and 378 product runtime-tool assertions using mocked AWS CLIs.
- Date-kind conformance for 159 calls across 14 load scripts; plain application
  check/build; test-type and cast ratchets.

The owned local database had all 129 selected tables enabled/forced with their
tenant policy and 53 complete migration records. This catalog count is distinct
from the seven usage-specific policy tests; it does not claim comprehensive
isolation testing of all 129 tables. Disposable test roles were removed by the
helpers. The schema-only database remains available as future synthetic load
input. These checks performed no real AWS or production operations.

Earlier 19/7 database logs and the superseded `5cc28ceb` settings-insert compiler
failure remain in the archive. The earlier logs did not embed a source SHA; the
manifest identifies their session-recorded tracked application source and later
helper/tool commits. The clean checkpoint reruns provide the reproducible source
binding. The compiler repair is `d2b4e52f`; the exact-source check/build/type runs
prove it resolved. A separate evidence-wrapper `npm.ps1` invocation failed before
TypeScript ran; its output is retained and the native `npm.cmd` rerun passed.

These are incremental focused records. Final combined CI, complete database/
frontend/extension acceptance, exact ZIP/pins, three cold 48-second/open-loop
capacity runs and live acceptance remain separate gates. No managed-device pass,
throughput result, deployment, activation or Store publication is asserted.

To inspect the archive from the repository root without extracting files:

```powershell
node -e "const fs = require('node:fs'); const z = require('node:zlib'); process.stdout.write(z.gunzipSync(fs.readFileSync('docs/release-evidence/release-297/focused-validation-5f406d8c.logs.ndjson.gz')));"
```

The manifest records hashes of both the gzip bytes and decompressed NDJSON bytes,
plus each sanitized log. Sanitization changes only recorded paths, synthetic
mock task-definition labels and line endings; a cluster-wide unrelated role count
is omitted from the owned-schema entry. Original raw-log hashes remain listed.
No credentials, raw AWS environment, student identities or private browsing/chat
content are included.
