/**
 * models/userStore.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Persistence for the `users` table. SQL and row-to-object mapping only —
 *   every rule about WHO may do WHAT lives in services/userService.js. This
 *   module will happily delete an administrator; it is not its job to argue.
 *
 *   Design notes:
 *     - Two shapes leave this module, and the split is deliberate. toUser()
 *       never includes password_hash, so the object that reaches a controller
 *       (and from there JSON.stringify) physically cannot carry a credential.
 *       The two findCredentials* functions return it in a separate field, and
 *       nothing but services/authService.js calls them.
 *     - Every lookup by name uses `lower(username) = lower($1)`, which is the
 *       expression indexed by users_username_lower_key in schema.sql. Written
 *       any other way the index is not used AND "Admin" stops matching
 *       "admin", so the phrasing is load-bearing twice over.
 *     - Ids are generated in Node with crypto.randomUUID(), matching
 *       grammarStore. The database has no default for users.id.
 *     - created_at is a TIMESTAMPTZ and pg returns a Date; toUser() converts
 *       it to an ISO string, exactly as grammarStore does, so no Date object
 *       escapes the persistence layer.
 */

import crypto from 'node:crypto';

import { query } from './db.js';
import { asUuid } from '../utils/uuid.js';

/** The columns describing a user. password_hash is NOT among them. */
const USER_COLUMNS = 'id, username, role, teacher_id, created_at';

/**
 * Map a row onto the public user shape.
 *
 * @param {object} row
 * @returns {{id: string, username: string, role: string, teacherId: string|null, createdAt: string}}
 */
function toUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    teacherId: row.teacher_id,
    createdAt: row.created_at.toISOString(),
  };
}

/* ------------------------------------------------------------------------ */
/* Lookups                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * @param {*} id Candidate user id.
 * @returns {Promise<object|null>} the user, or null if absent.
 */
export async function findById(id) {
  const uuid = asUuid(id);
  if (uuid === null) return null;

  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [uuid]);
  return rows.length === 0 ? null : toUser(rows[0]);
}

/**
 * Look a user up by name for SIGN-IN, returning the stored hash alongside.
 *
 * @param {*} username Candidate username (matched case-insensitively).
 * @returns {Promise<{user: object, passwordHash: string}|null>}
 */
export async function findCredentialsByUsername(username) {
  if (typeof username !== 'string' || username === '') return null;

  const { rows } = await query(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(username) = lower($1)`,
    [username]
  );
  return rows.length === 0 ? null : { user: toUser(rows[0]), passwordHash: rows[0].password_hash };
}

/**
 * The same, by id — used when someone changes their OWN password and must
 * prove they know the current one.
 *
 * @param {*} id Candidate user id.
 * @returns {Promise<{user: object, passwordHash: string}|null>}
 */
export async function findCredentialsById(id) {
  const uuid = asUuid(id);
  if (uuid === null) return null;

  const { rows } = await query(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE id = $1`,
    [uuid]
  );
  return rows.length === 0 ? null : { user: toUser(rows[0]), passwordHash: rows[0].password_hash };
}

/* ------------------------------------------------------------------------ */
/* Listing                                                                   */
/* ------------------------------------------------------------------------ */

/** Every user, oldest first so the administrator heads the list. */
export async function listAll() {
  const { rows } = await query(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at, username`
  );
  return rows.map(toUser);
}

/**
 * The students belonging to one teacher.
 *
 * @param {*} teacherId The teacher's id.
 * @returns {Promise<object[]>} their students, oldest first.
 */
export async function listByTeacher(teacherId) {
  const uuid = asUuid(teacherId);
  if (uuid === null) return [];

  const { rows } = await query(
    `SELECT ${USER_COLUMNS} FROM users WHERE teacher_id = $1 ORDER BY created_at, username`,
    [uuid]
  );
  return rows.map(toUser);
}

/* ------------------------------------------------------------------------ */
/* Writes                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Insert a user. The caller has already decided this is allowed and has
 * hashed the password.
 *
 * @param {object} user
 * @param {string} user.username     Already normalised to lower case.
 * @param {string} user.passwordHash From utils/password.js.
 * @param {string} user.role         'teacher' | 'student' (the CHECK also permits
 *                                   'admin', which only migrate.js ever writes).
 * @param {string|null} user.teacherId Owning teacher for students; null otherwise.
 * @returns {Promise<object>} the stored user.
 * @throws {Error} pg error 23505 when the name is taken — the service turns
 *         that into 409, because only it knows what to say about it.
 */
export async function insert({ username, passwordHash, role, teacherId = null }) {
  const { rows } = await query(
    `INSERT INTO users (id, username, password_hash, role, teacher_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${USER_COLUMNS}`,
    [crypto.randomUUID(), username, passwordHash, role, teacherId]
  );
  return toUser(rows[0]);
}

/**
 * Delete a user. Their students, grammars and sessions go with them, by the
 * ON DELETE CASCADE foreign keys declared in schema.sql — which is also what
 * makes deletion take effect on a signed-in victim immediately.
 *
 * @param {*} id
 * @returns {Promise<boolean>} true if a row was deleted.
 */
export async function remove(id) {
  const uuid = asUuid(id);
  if (uuid === null) return false;

  const { rowCount } = await query('DELETE FROM users WHERE id = $1', [uuid]);
  return rowCount > 0;
}

/**
 * Replace a user's password hash.
 *
 * @param {*} id
 * @param {string} passwordHash
 * @returns {Promise<boolean>} true if a row was updated.
 */
export async function updatePasswordHash(id, passwordHash) {
  const uuid = asUuid(id);
  if (uuid === null) return false;

  const { rowCount } = await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    uuid,
    passwordHash,
  ]);
  return rowCount > 0;
}
