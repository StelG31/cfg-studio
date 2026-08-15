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

/**
 * Syscall-level failures seen while opening the socket. ECONNRESET and EPIPE
 * belong here — during connection setup they are unambiguous, because no
 * statement has been sent yet. A suspended serverless database typically
 * refuses or resets the first connection, which is precisely this case.
 */
const RETRYABLE_SYSCALL_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * PostgreSQL SQLSTATEs raised while refusing a connection. 57P03
 * (cannot_connect_now) is the server explicitly saying "still starting up".
 * Class 08 is connection_exception.
 *
 * 08007 (transaction_resolution_unknown) is excluded before the class check
 * below, and must stay excluded: it is the one code meaning "we cannot tell
 * whether your transaction committed".
 */
const RETRYABLE_SQL_STATES = new Set(['57P01', '57P02', '57P03']);

/** A waking database needs a moment; an instant retry just burns the budget. */
const RETRY_DELAY_MS = 250;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Whether one more attempt at OPENING a connection is worth making.
 *
 * @param {Error} err Error thrown while connecting.
 * @returns {boolean}
 */
function isTransientConnectionError(err) {
  const code = err?.code;
  // Excluded before the class-08 rule below so that widening that rule can
  // never quietly re-admit it.
  if (code === '08007') return false;
  if (typeof code === 'string' && code.startsWith('08')) return true;
  if (RETRYABLE_SQL_STATES.has(code)) return true;
  if (RETRYABLE_SYSCALL_CODES.has(code)) return true;
  // pg-pool reports its own connectionTimeoutMillis as a bare Error with no
  // code. Matching the message is ugly, but this failure is pre-execution by
  // definition and there is no other discriminator.
  return err?.message === 'timeout exceeded when trying to connect';
}

/**
 * Check out a client, retrying ONCE on a transient connection failure.
 *
 * The retry wraps connect() and NOT the query, and that is a correctness
 * property rather than a stylistic choice. Failing to obtain a connection
 * proves no statement was sent, so repeating it cannot duplicate anything.
 * Once a statement has been written to the socket its outcome is unknowable
 * — a reset may mean "never arrived", "rolled back", or "committed but the
 * acknowledgement was lost" — so statements are never retried. This is what
 * makes a duplicate INSERT unreachable rather than merely unlikely.
 *
 * @returns {Promise<import('pg').PoolClient>}
 */
async function acquire() {
  try {
    return await getPool().connect();
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;

    console.warn(
      `[db] Connection failed (${err.code || err.message}); retrying once in ${RETRY_DELAY_MS}ms.`
    );
    await delay(RETRY_DELAY_MS);
    return getPool().connect();
  }
}

/**
 * Run a statement, or — with no parameters — a multi-statement script.
 *
 * @param {string} text     SQL, with $1-style placeholders.
 * @param {Array}  [params] Bound values. JSONB values must already be
 *        strings: pg serialises a JS array as a PostgreSQL array literal.
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params) {
  const client = await acquire();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

/** Close the pool so the process (or Jest) can exit cleanly. Idempotent. */
export async function close() {
  if (pool === null) return;

  const closing = pool;
  pool = null;
  await closing.end();
}
