/**
 * tests/setup/globalTeardown.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Drop the schema the run created, so nothing is left behind for the next
 *   run (or the next psql session) to be confused by.
 *
 *   It opens its own client instead of reusing models/db.js: that pool was
 *   already closed, and a pg pool cannot be restarted after end().
 *
 *   The same two loading constraints as globalSetup.js apply — default
 *   export, no top-level await.
 */

import 'dotenv/config';
import pg from 'pg';

import { TEST_SCHEMA, baseTestUrl } from './testDb.js';

export default async function globalTeardown() {
  const client = new pg.Client({ connectionString: baseTestUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  } finally {
    await client.end();
  }
}
