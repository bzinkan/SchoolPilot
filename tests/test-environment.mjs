// The application Redis URL in a developer .env must not start long-lived
// realtime clients while the Node test runner imports application modules.
// Redis integration tests use TEST_REDIS_URL explicitly instead.
process.env.REDIS_URL = "";
