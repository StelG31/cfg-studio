/**
 * tests/setup/testDb.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Shared configuration for the throw-away database the Jest run uses.
 *
 *   Isolation is achieved entirely through the connection string: the suite
 *   runs inside its own PostgreSQL SCHEMA, selected with the `options`
 *   startup parameter. Nothing in the application distinguishes test from
 *   production — models/db.js simply reads DATABASE_URL and connects.
 */

/**
 * The schema every test object lives in. Fixed rather than random: `jest
 * --runInBand` runs the files serially in one process, so there is no
 * concurrency to disambiguate, and a fixed name means globalSetup and
 * globalTeardown need no way to pass state to each other.
 */
export const TEST_SCHEMA = 'cfg_studio_test';

/** Credentials the suite bootstraps its administrator with. */
export const TEST_ADMIN = { username: 'test-admin', password: 'test-admin-password' };

/**
 * Connection string for the test database WITHOUT the schema selection —
 * used by the setup and teardown hooks, which have to create and drop the
 * schema and therefore must not already be inside it.
 *
 * @returns {string}
 */
export function baseTestUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The test suite needs a LOCAL PostgreSQL ' +
        'database — see the "Local database setup" section of README.md.'
    );
  }

  // This hook drops a schema. Refusing any database whose name does not end
  // in _test turns "I pasted the wrong URL" into a loud failure rather than
  // a silent loss of real data.
  const database = new URL(url).pathname.replace(/^\//, '');
  if (!database.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database "${database}": the name must end with "_test".`
    );
  }

  return url;
}

/**
 * Connection string scoped to the test schema. This is what DATABASE_URL is
 * set to, so every query the application makes lands in the test schema and
 * development data is untouchable.
 *
 * @returns {string}
 */
export function scopedTestUrl() {
  const url = new URL(baseTestUrl());
  url.searchParams.set('options', `-c search_path=${TEST_SCHEMA}`);
  return url.toString();
}
