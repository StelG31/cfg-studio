/**
 * tests/setup/globalSetup.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Give the whole Jest run one empty, throw-away PostgreSQL schema, fully
 *   migrated, before any test file is loaded.
 *
 *   Two constraints this file must respect, both imposed by how Jest loads
 *   it (jest-util/requireOrImportModule require()s the file first and only
 *   falls back to import() on ERR_REQUIRE_ESM):
 *     1. It MUST have a default export — a named export is rejected.
 *     2. It must contain NO top-level await. On Node 22 the require() path
 *        succeeds for ES modules, but an async module raises
 *        ERR_REQUIRE_ASYNC_MODULE, which that fallback does not catch.
 *   Hence every asynchronous step lives inside the exported function.
 */

import 'dotenv/config';
import pg from 'pg';

import { TEST_SCHEMA, TEST_ADMIN, baseTestUrl, scopedTestUrl } from './testDb.js';

export default async function globalSetup() {
  // Recreate the schema rather than trusting it to be clean: a run that was
  // killed half way through leaves rows behind, and a suite that depends on
  // the previous run's state is a suite that fails at random.
  const client = new pg.Client({ connectionString: baseTestUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  } finally {
    await client.end();
  }

  // Set before anything imports models/db.js. Each Jest test environment
  // snapshots process.env when it is created, which is strictly after this
  // hook has finished, so the value reaches every test file.
  process.env.DATABASE_URL = scopedTestUrl();

  // Grammars are owned by an administrator, so the suite needs one.
  process.env.ADMIN_USERNAME = TEST_ADMIN.username;
  process.env.ADMIN_PASSWORD = TEST_ADMIN.password;

  // Dynamic imports: static ones are evaluated before the assignments above
  // exist, and models/db.js would then build a pool for the wrong database.
  const { migrate } = await import('../../models/migrate.js');
  const db = await import('../../models/db.js');
  try {
    await migrate();
  } finally {
    // This pool belongs to the Jest main process; the application opens its
    // own inside each test sandbox. Leaving it open would keep Jest alive.
    await db.close();
  }
}
