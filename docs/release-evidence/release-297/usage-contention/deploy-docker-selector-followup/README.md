# Deployment Docker selector follow-up

Preserves the bcb2 CI failure and its local reproduction. The deployment script now pins Docker with the global `--host` option, so literal `docker login/tag/push` selectors were stale. The test-only correction preserves command-presence and preflight ordering and strengthens same-image mutation prohibitions to recognize host-qualified commands.

**147 distinct tests passed**: 144 from complete affected/adjacent suites and three additional identified static-order checks. No tests were skipped in these selections. The whole infrastructure lane was not rerun locally. Application and deployment source remains unchanged from bcb2; combined08 capacity remains failed. Exact commands, byte bindings and immutable compressed evidence are in `manifest.json`.
