// The application Redis URL in a developer .env must not start long-lived
// realtime clients while the Node test runner imports application modules.
// Redis integration tests use TEST_REDIS_URL explicitly instead.
process.env.REDIS_URL = "";

// A developer .env must not turn a deliberate fault/denial fixture into an
// external message. Provider tests explicitly install their own fake keys and
// transports after this preload; ordinary tests keep operational alerts local.
// Pin empty strings: dotenv.config() may run again inside application imports
// and would refill deleted keys from the developer file.
process.env.SENDGRID_API_KEY = "";
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";

// Exercise the normal manual-session issuance contract throughout the test
// suite. Phase A's production default-off posture is covered explicitly by
// dedicated tests that clear or override this value before loading the route.
process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = "true";
