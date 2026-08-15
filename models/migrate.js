/**
 * models/migrate.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Bring the database up to the shape the application expects, on every
 *   boot. Two steps: apply models/schema.sql, then create the first
 *   administrator if one is configured and does not exist yet.
 *
 *   Design notes:
 *     - schema.sql is sent as ONE parameterless query. pg transmits that
 *       over the simple query protocol, so every statement in the file —
 *       including its own BEGIN/COMMIT and advisory lock — runs in a single
 *       round trip and a single transaction.
 *     - The bootstrap uses ON CONFLICT DO NOTHING, never DO UPDATE. A
 *       redeploy must not silently reset a password the administrator has
 *       since changed, nor resurrect a credential that was rotated because
 *       it leaked.
 *     - Concurrent boots need no extra locking here: an instance that loses
 *       the race blocks inside schema.sql's advisory lock and only reaches
 *       the bootstrap after the winner has committed the tables.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { query } from './db.js';
import { hashPassword } from '../utils/password.js';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

/** Apply the schema, then bootstrap the first administrator. */
export async function migrate() {
  const schema = await readFile(SCHEMA_PATH, 'utf8');
  await query(schema);
  console.log('[migrate] Schema is up to date.');

  await bootstrapAdmin();
}

/**
 * Create the first admin from the environment, if it does not exist yet.
 *
 * Missing credentials are a warning rather than a fatal error: the grammar
 * algorithms, the samples and the whole UI work without an administrator.
 * Only saving needs one, and that failure reports itself clearly when it
 * happens (see models/grammarStore.js).
 */
async function bootstrapAdmin() {
  // Usernames are stored lower-cased: UNIQUE on TEXT is case-sensitive, so
  // "Admin" and "admin" would otherwise become two separate accounts.
  const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';

  if (!username || !password) {
    console.warn(
      '[migrate] ADMIN_USERNAME and ADMIN_PASSWORD are not both set — no ' +
        'administrator was created. The app will start, but saving a grammar ' +
        'will fail until an administrator exists. Set both and restart.'
    );
    return;
  }

  const passwordHash = await hashPassword(password);

  const { rowCount } = await query(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (username) DO NOTHING`,
    [crypto.randomUUID(), username, passwordHash]
  );

  console.log(
    rowCount === 1
      ? `[migrate] Administrator "${username}" created.`
      : `[migrate] Administrator "${username}" already exists — password left unchanged.`
  );
}
