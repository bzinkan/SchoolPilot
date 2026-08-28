// The application Redis URL in a developer .env must not start long-lived
// realtime clients while the Node test runner imports application modules.
// Redis integration tests use TEST_REDIS_URL explicitly instead.
process.env.REDIS_URL = "";

// Exercise the normal manual-session issuance contract throughout the test
// suite. Phase A's production default-off posture is covered explicitly by
// dedicated tests that clear or override this value before loading the route.
process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = "true";
