/**
 * Test environment. Deliberately does not set DATABASE_URL or HAPANA_API_KEY:
 * the suite runs against the in-memory store and the Hapana mock, so it needs
 * no network and no database. The integration test opts in separately when
 * DATABASE_URL is present.
 */
process.env.SESSION_SECRET ??= 'test-secret-not-used-anywhere-real';
process.env.PUBLIC_BASE_URL ??= 'http://localhost:8888';
process.env.EMAIL_PROVIDER ??= 'console';
process.env.ALLOWED_ORIGINS ??= 'http://localhost:8888';
process.env.DEFAULT_VENUE_ID ??= 'east-fremantle';
