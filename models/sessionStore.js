/**
 * models/sessionStore.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Persistence for the `sessions` table — one row per signed-in browser.
 *
 *   The id stored here is the SHA-256 of the cookie token, hex-encoded, NEVER
 *   the token itself; schema.sql enforces that with a CHECK constraint. This
 *   module therefore only ever receives an already-hashed id: the hashing
 *   happens in services/authService.js, which is the only place the raw token
 *   exists. Everything in this file treats the id as an opaque key.
 *
 *   Why a session table rather than a signed token (JWT): a row can be
 *   deleted. Logging out, deleting a user and resetting a password all have
 *   to take effect at once, and a self-contained token stays valid until it
 *   expires no matter what the server would prefer.
 *
 *   Expiry is checked in SQL (`expires_at > now()`) rather than in Node, so
 *   the database clock decides — the same clock that wrote the row, and the
 *   same one for every instance of the app.
 */

import { query } from './db.js';
import { asUuid } from '../utils/uuid.js';

/**
 * The shape schema.sql's CHECK constraint accepts. Validated here as well so
 * that a garbage cookie produces "no such session" instead of a constraint
 * violation surfacing as a 500.
 */
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

function asSessionId(id) {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id) ? id : null;
}

/**
 * Open a session.
 *
 * @param {string} id      sha256(token), hex-encoded lower case.
 * @param {string} userId  The signed-in user.
 * @param {number} ttlMs   Lifetime from now.
 * @returns {Promise<{id: string, expiresAt: string}>}
 * @throws {Error} when the id is not a hex digest — a programming mistake
 *         that must be loud, since the alternative is storing a live
 *         credential in a column the CHECK exists to protect.
 */
export async function create(id, userId, ttlMs) {
  const sessionId = asSessionId(id);
  if (sessionId === null) {
    throw new Error('sessionStore.create expects sha256(token) in hex, not a raw token.');
  }

  const { rows } = await query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
     RETURNING id, expires_at`,
    [sessionId, userId, ttlMs / 1000]
  );

  return { id: rows[0].id, expiresAt: rows[0].expires_at.toISOString() };
}

/**
 * Resolve a session to the user it belongs to, in one statement — the join
 * saves a round trip on every authenticated request, and an expired row is
 * indistinguishable from an absent one to the caller.
 *
 * @param {string} id sha256(token), hex-encoded.
 * @returns {Promise<object|null>} the signed-in user, or null.
 */
export async function findValid(id) {
  const sessionId = asSessionId(id);
  if (sessionId === null) return null;

  const { rows } = await query(
    `SELECT u.id, u.username, u.role, u.teacher_id, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
        AND s.expires_at > now()`,
    [sessionId]
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    teacherId: row.teacher_id,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Close one session (sign out).
 *
 * @param {string} id sha256(token), hex-encoded.
 * @returns {Promise<boolean>} true if a row was deleted.
 */
export async function remove(id) {
  const sessionId = asSessionId(id);
  if (sessionId === null) return false;

  const { rowCount } = await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  return rowCount > 0;
}

/**
 * Close every session a user has. Called whenever their password changes, by
 * their own hand or by a reset: whoever held the old password must lose the
 * access it bought them, and a still-valid cookie would be exactly that.
 *
 * @param {*} userId
 * @returns {Promise<number>} how many sessions were closed.
 */
export async function removeAllForUser(userId) {
  const uuid = asUuid(userId);
  if (uuid === null) return 0;

  const { rowCount } = await query('DELETE FROM sessions WHERE user_id = $1', [uuid]);
  return rowCount;
}

/**
 * Sweep expired rows. They are already refused by findValid(), so this is
 * housekeeping rather than a security measure — it keeps the table from
 * growing without bound. Backed by sessions_expires_at_idx.
 *
 * @returns {Promise<number>} how many rows were removed.
 */
export async function deleteExpired() {
  const { rowCount } = await query('DELETE FROM sessions WHERE expires_at <= now()');
  return rowCount;
}
