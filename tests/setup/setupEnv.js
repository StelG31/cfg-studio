/**
 * tests/setup/setupEnv.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Point DATABASE_URL at the test schema inside every test sandbox, before
 *   any application module is imported.
 *
 *   globalSetup already sets these on the parent process and Jest snapshots
 *   process.env into each sandbox, so this is belt and braces — but it costs
 *   nothing and it makes the guarantee explicit rather than dependent on an
 *   implementation detail of Jest's sandboxing.
 *
 *   Deliberately imports nothing from models/: five of the six test files
 *   exercise pure core algorithms and must not acquire a database
 *   dependency just by running.
 */

import 'dotenv/config';

import { TEST_ADMIN, scopedTestUrl } from './testDb.js';

process.env.DATABASE_URL = scopedTestUrl();
process.env.ADMIN_USERNAME = TEST_ADMIN.username;
process.env.ADMIN_PASSWORD = TEST_ADMIN.password;
