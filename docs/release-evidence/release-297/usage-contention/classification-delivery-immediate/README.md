# Heartbeat classification correction and immediate educational classification

The original route could record a heartbeat, fail optional teacher telemetry, and exit before classification registration. It could also suppress current safety processing when classification publication failed. The retained red run reproduces those failures.

The corrected route registers historical work independently, fences current effects, and waits for full foreground metadata before any later classification-only frame. A separate performance slice stores canonical educational/no-safety classification in the initial heartbeat INSERT and complete first snapshot. It skips later work only when RETURNING proves the fields were stored.

Focused final tests pass47/47; a separate independent canonical-classifier differential passes47/47. These are distinct suites. Native storage isolation and the next combined-source capacity run are separate evidence. No deployment readiness or capacity pass is claimed here.

See `manifest.json` for raw hashes, exact scope, intermediate failed test-run explanation, source snapshots and limitations.
