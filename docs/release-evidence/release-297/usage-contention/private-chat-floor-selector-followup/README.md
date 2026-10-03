# Deployment release-floor selector follow-up

The original ff6 backend CI failure is preserved. Its static test looked for `docker build -t`; the reviewed scan gate adds build options before `-t`. The test now locates the actual build command, requires it to exist, and retains the preflight, migration-ordering and source-binding assertions.

The complete affected suite passed **25/25**, with no skips. Application and deployment bytes match the ff6 checkpoint; this is a test-only correction, not capacity or deployment acceptance. See `manifest.json` for exact command, source hashes and immutable compressed log records.
