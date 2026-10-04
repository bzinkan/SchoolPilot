# PassPilot Rules midnight fixture correction

The bcb2 CI failures occurred at00:00:15 America/Los_Angeles. Four blocking-pass fixtures subtracted60seconds and unintentionally seeded the previous school day. The production rules correctly excluded those passes. A shared test-only helper now clamps the intended same-day seed to local midnight; genuine prior-day coverage remains unchanged.

The final owned CI-schema fixture passed **19/19** complete Rules tests plus **5/5** replay cases with Date fixed to the exact original midnight, with no skips. Recorded relevant source hashes remained stable; owned cleanup is confirmed. This is owner-role DB-lane evidence, not restricted-role or final release acceptance.

The original CI failure, failed fully migrated donor attempt, source-drift run and final stable proof are all retained with raw/sanitized/archive hashes in `manifest.json`.
