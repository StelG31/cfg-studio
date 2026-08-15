/**
 * models/db.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The single PostgreSQL connection pool for CFG Studio. Every module that
 *   talks to the database goes through query() here — there is exactly one
 *   pool in the process, so connection limits are predictable.
 *
 *   Design notes:
 *     - The pool is created LAZILY on first use rather than at import time.
 *       Importing a module must never open sockets: it keeps app.js
 *       importable without a database and lets the test harness set
 *       DATABASE_URL before the first query runs. Startup still fails fast,
 *       because the migration runs before the server listens.
 *     - TLS is NOT configured in code. The connection string drives it, so
 *       `sslmode=verify-full` secures the hosted database and
 *       `sslmode=disable` works against a local one — with no branch in the
 *       application distinguishing the two. Nothing here is specific to any
 *       hosting provider.
 *     - The pool is deliberately SMALL. This is a low-traffic educational
 *       app and free database tiers cap connections aggressively; five is
 *       plenty and leaves headroom for migrations and psql sessions.
 *     - A single retry covers serverless databases that scale to zero: the
 *       first query after an idle period can fail while compute wakes up.
 *       See isRetryable() for why only SOME failures qualify.
 */

import pg from 'pg';

const { Pool } = pg;

/**
 * Keep connections short-lived. A suspended serverless database drops idle
 * sockets on its side; holding them here only produces errors on next use.
 */
const POOL_SETTINGS = {
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
};

/** Syscall-level failures: the TCP connection was never established. */
const RETRYABLE_SYSCALL_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * PostgreSQL SQLSTATEs safe to retry.
 *
 * 57P03 (cannot_connect_now) is the server explicitly saying "still starting
 * up" — exactly the scale-to-zero wake-up case, and no statement has run.
 *
 * Notably ABSENT, on purpose: 08007 (transaction_resolution_unknown) and
 * mid-query ECONNRESET/EPIPE. Those are ambiguous — the statement may well
 * have committed before the connection died, and retrying a committed INSERT
 * would silently duplicate a row. A slow error beats a wrong write.
 */
const RETRYABLE_SQL_STATES = new Set(['57P03']);

let pool = null;

/**
 * Read the connection string, refusing to invent a fallback: a hardcoded
 * default is how a misconfigured production process quietly ends up writing
 * to the wrong database.
 */
function requireConnectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. CFG Studio stores all data in PostgreSQL and ' +
        'cannot start without it. Copy .env.example to .env and set DATABASE_URL ' +
        '(see the "Local database setup" section of README.md).'
    );
  }
  return url;
}

function getPool() {
  if (pool === null) {
    pool = new Pool({ connectionString: requireConnectionString(), ...POOL_SETTINGS });

    // An idle client can fail on the server side (suspended database, admin
    // restart). Without a listener that error would be unhandled and take
    // the whole process down; the pool discards the client either way.
    pool.on('error', (err) => {
      console.warn(`[db] Idle client error (connection discarded): ${err.message}`);
    });
  }
  return pool;
}

/**
 * True only when the query provably never reached the server, so re-running
 * it cannot duplicate an effect.
 *
 * @param {Error} err Error thrown by pg.
 * @returns {boolean}
 */
function isRetryable(err) {
  if (RETRYABLE_SYSCALL_CODES.has(err.code)) return true;
  if (RETRYABLE_SQL_STATES.has(err.code)) return true;
  // The pool timed out waiting for a free connection to be established.
  return err.message === 'timeout exceeded when trying to connect';
}

/**
 * Run a parameterized statement.
 *
 * @param {string} text   SQL, with $1-style placeholders.
 * @param {Array}  params Bound values.
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params) {
  try {
    return await getPool().query(text, params);
  } catch (err) {
    if (!isRetryable(err)) throw err;

    console.warn(`[db] Connection failed (${err.code || err.message}); retrying once.`);
    return getPool().query(text, params);
  }
}

/**
 * Check out a dedicated client for work that must run on ONE session —
 * advisory locks and transactions. Callers must release it in a finally
 * block. Not retried: a retry would silently move the work to a different
 * session, which defeats the reason for checking a client out at all.
 *
 * @returns {Promise<import('pg').PoolClient>}
 */
export async function getClient() {
  return getPool().connect();
}

/** Close the pool so the process (or Jest) can exit cleanly. Idempotent. */
export async function close() {
  if (pool === null) return;

  const closing = pool;
  pool = null;
  await closing.end();
}
