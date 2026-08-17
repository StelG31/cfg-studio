/**
 * services/userService.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Account management and — far more importantly — canAccess(), the ONE
 *   function that decides every authorization question in CFG Studio.
 *
 *   The hierarchy this enforces:
 *
 *       admin  ──creates──▶  teacher  ──creates──▶  student
 *
 *   There is no public registration. An account can only be brought into
 *   existence by the role above it, which is what guarantees the invariant
 *   the rest of the file leans on: every student has a teacher.
 *
 *   Why ONE function rather than a check in each controller:
 *     With three roles the question stopped being "is this mine?" and became
 *     "is this within my jurisdiction?" — a relation between two users, not a
 *     property of one. Spread across a dozen handlers that relation gets
 *     written a dozen ways, and the one that is subtly wrong is a security
 *     hole nobody notices, because every individual site looks plausible.
 *     Here the whole policy is a single table that can be read in one sitting
 *     and is walked exhaustively by tests/authorization.test.js.
 *
 *   canAccess is PURE and SYNCHRONOUS: no database, no req, no await. That is
 *   not tidiness. It is what lets the test suite enumerate every (actor,
 *   action, target) triple as a plain table, which is the only way to know
 *   the matrix is actually implemented rather than approximately implemented.
 *
 *   Two rules the callers depend on, stated once here:
 *
 *     1. FAIL CLOSED. An unknown action, an unknown role, a missing target or
 *        an anonymous actor all answer false. A typo in an action name can
 *        therefore only ever deny access, never grant it.
 *
 *     2. 404 BEFORE 403. If the actor cannot READ the target, callers answer
 *        "not found"; only for targets they can see do they admit the action
 *        was forbidden. Otherwise a probe could map out which usernames and
 *        grammar ids exist by reading the difference between the two codes.
 *        Both halves of that decision come from canAccess, so it is one rule
 *        applied mechanically rather than a judgement call per endpoint.
 */

import crypto from 'node:crypto';

import * as userStore from '../models/userStore.js';
import * as sessionStore from '../models/sessionStore.js';
import { hashPassword } from '../utils/password.js';
import { HttpError } from '../utils/httpError.js';
import { isUuid } from '../utils/uuid.js';

/* ------------------------------------------------------------------------ */
/* The permission matrix                                                     */
/* ------------------------------------------------------------------------ */

/** The only roles that exist. Mirrors the CHECK constraint in schema.sql. */
const ROLES = new Set(['admin', 'teacher', 'student']);

/** Roles an account may be CREATED with. 'admin' is deliberately absent. */
export const CREATABLE_ROLES = Object.freeze(['teacher', 'student']);

/**
 * True when `target` is a student of `actor`. The null check matters: an
 * admin and a teacher both have teacherId === null, so without it any two
 * of them would look like a teacher-student pair.
 */
function isOwnStudent(actor, target) {
  return (
    target.role === 'student' && target.teacherId != null && target.teacherId === actor.id
  );
}

/** True when the actor personally owns the grammar. */
function ownsGrammar(actor, target) {
  return target.ownerId != null && target.ownerId === actor.id;
}

/**
 * The matrix itself, one entry per action. Each rule receives a validated
 * actor (non-null, known role) and the raw target, and answers a boolean.
 *
 * Target shapes:
 *   user actions    { id, role, teacherId }
 *   grammar actions { ownerId, ownerTeacherId }
 *   no target       null
 */
const RULES = {
  /**
   * Only the role above may create you. An admin creating a student must name
   * the teacher the student will belong to (the caller resolves teacherId
   * before asking); a teacher may only create students under themselves.
   */
  'user:create': (actor, target) => {
    if (!target || !CREATABLE_ROLES.includes(target.role)) return false;
    if (actor.role === 'admin') return true;
    if (actor.role === 'teacher') {
      return target.role === 'student' && target.teacherId === actor.id;
    }
    return false;
  },

  /**
   * The row-level companion of 'user:list' — not a separate permission, but
   * the same jurisdiction asked about one user. It exists so that the
   * 404-before-403 rule and the list scope both derive from this table
   * instead of being restated.
   */
  'user:read': (actor, target) => {
    if (!target) return false;
    if (actor.role === 'admin') return true;
    if (target.id === actor.id) return true; // everyone can see themselves
    if (actor.role === 'teacher') return isOwnStudent(actor, target);
    return false;
  },

  /** Admins list everyone; teachers list their own students; students cannot. */
  'user:list': (actor) => actor.role === 'admin' || actor.role === 'teacher',

  /**
   * Refusing self-deletion is an authorization rule, not a UI nicety, so it
   * belongs here: an administrator who deletes their own account takes every
   * other account's only route to a password reset with them.
   */
  'user:delete': (actor, target) => {
    if (!target || target.id === actor.id) return false;
    if (actor.role === 'admin') return true;
    if (actor.role === 'teacher') return isOwnStudent(actor, target);
    return false;
  },

  /** Recovery for someone who has forgotten their password. */
  'user:resetPassword': (actor, target) => {
    if (!target) return false;
    if (actor.role === 'admin') return true;
    if (actor.role === 'teacher') return isOwnStudent(actor, target);
    return false;
  },

  /**
   * Changing your OWN password, proving you know the current one. Without
   * this, whoever created an account would know its password forever, since
   * only they could ever set one.
   */
  'user:changeOwnPassword': (actor, target) => Boolean(target) && target.id === actor.id,

  /** Everyone who is signed in may save their own work. */
  'grammar:create': () => true,

  /** A teacher additionally sees everything their own students have saved. */
  'grammar:read': (actor, target) => {
    if (!target) return false;
    if (actor.role === 'admin') return true;
    if (ownsGrammar(actor, target)) return true;
    if (actor.role === 'teacher') {
      return target.ownerTeacherId != null && target.ownerTeacherId === actor.id;
    }
    return false;
  },

  /**
   * Read and write are deliberately NOT symmetric for a teacher: they may
   * read a student's grammar but never alter it. A student's work stays the
   * student's, which is the whole point of showing it to a teacher.
   */
  'grammar:update': (actor, target) =>
    Boolean(target) && (actor.role === 'admin' || ownsGrammar(actor, target)),
  'grammar:delete': (actor, target) =>
    Boolean(target) && (actor.role === 'admin' || ownsGrammar(actor, target)),

  /**
   * Every signed-in role may run the algorithms. Listed for completeness of
   * the matrix; no route consults it, because /api/validate, /api/cnf,
   * /api/cyk and /api/examples are open to anonymous callers by design —
   * they are stateless, size-limited by LIMITS in computeService.js, and hold
   * no user data. That is a decision about those four endpoints, not an
   * exception to this table.
   */
  'algorithm:use': () => true,
};

/** Every action name, for the exhaustive sweep in tests. */
export const ACTIONS = Object.freeze(Object.keys(RULES));

/**
 * The single authorization decision in the application.
 *
 * @param {object|null} actor  The signed-in user ({id, username, role, teacherId}),
 *        or null/undefined for an anonymous request.
 * @param {string} action      One of ACTIONS.
 * @param {object|null} [target] The thing being acted on; see RULES above.
 * @returns {boolean} true only when the action is permitted.
 */
export function canAccess(actor, action, target = null) {
  if (actor === null || typeof actor !== 'object') return false;
  if (!ROLES.has(actor.role)) return false;
  if (typeof actor.id !== 'string' || actor.id === '') return false;

  const rule = RULES[action];
  if (rule === undefined) return false; // unknown action → denied, never granted

  return rule(actor, target ?? null) === true;
}

/* ------------------------------------------------------------------------ */
/* List scoping                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The filter a LIST query must apply, derived from the same jurisdiction the
 * matrix above describes.
 *
 * canAccess answers about one row; a listing needs a WHERE clause, and a
 * hand-written second rule set is precisely the drift this phase exists to
 * prevent. So this is the ONLY producer of list filters, and
 * tests/authorization.test.js pins it to the matrix empirically: it inserts
 * rows owned by every fixture user, runs the real query, and asserts the
 * returned set equals the set canAccess admits one row at a time. A scope
 * that grows wider than the policy fails that test.
 *
 * @param {object} actor
 * @param {'grammar:read'|'user:list'} action
 * @returns {{kind: 'all'|'self'|'self-and-students'|'students'|'none', userId: string|null}}
 */
export function scopeFor(actor, action) {
  const NOTHING = { kind: 'none', userId: null };

  if (action === 'user:list') {
    if (!canAccess(actor, 'user:list')) return NOTHING;
    return actor.role === 'admin'
      ? { kind: 'all', userId: null }
      : { kind: 'students', userId: actor.id };
  }

  if (action === 'grammar:read') {
    // "May you read a grammar you own yourself?" — false only for an
    // anonymous or malformed actor. Asking canAccess rather than testing
    // actor.role again keeps even this guard on the one policy table.
    if (!canAccess(actor, 'grammar:read', { ownerId: actor?.id })) return NOTHING;

    if (actor.role === 'admin') return { kind: 'all', userId: null };
    return actor.role === 'teacher'
      ? { kind: 'self-and-students', userId: actor.id }
      : { kind: 'self', userId: actor.id };
  }

  return NOTHING; // fail closed on an action that has no listing
}

/* ------------------------------------------------------------------------ */
/* Credential policy                                                         */
/* ------------------------------------------------------------------------ */

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const PASSWORD_MIN = 8;

/**
 * An upper bound is not pedantry: scrypt's cost is driven by its parameters,
 * but hashing an unbounded string still copies it, and a login endpoint that
 * accepts megabyte passwords is a cheap way to burn server memory.
 */
const PASSWORD_MAX = 200;

/**
 * Normalise and check a username.
 *
 * Lower-casing on input is what makes users_username_lower_key's promise
 * visible to people: "Admin" and "admin" are one account, and someone who
 * types their own name with different capitalisation still signs in.
 *
 * @param {*} value Raw username from the client.
 * @returns {string} the normalised username.
 * @throws {HttpError} 400 INVALID_USERNAME.
 */
export function normaliseUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USERNAME_PATTERN.test(username)) {
    throw HttpError.badRequest(
      'INVALID_USERNAME',
      'A username must be 3–32 characters long and use only letters, digits, dots, hyphens or underscores.'
    );
  }
  return username;
}

/**
 * @param {*} value Raw password from the client.
 * @returns {string} the same password, now known to be usable.
 * @throws {HttpError} 400 WEAK_PASSWORD.
 */
export function assertPasswordPolicy(value) {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw HttpError.badRequest(
      'WEAK_PASSWORD',
      `A password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters long.`
    );
  }
  return value;
}

/** PostgreSQL's unique_violation, raised by either username index. */
const UNIQUE_VIOLATION = '23505';

/* ------------------------------------------------------------------------ */
/* Operations                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Fetch a user and apply the 404-before-403 rule in one place, so no caller
 * can accidentally leak existence by getting the order wrong.
 *
 * @param {object} actor
 * @param {*} id Target user id from the URL.
 * @returns {Promise<object>} the target user.
 * @throws {HttpError} 400 INVALID_ID | 404 USER_NOT_FOUND.
 */
async function requireVisibleUser(actor, id) {
  if (!isUuid(id)) {
    throw HttpError.badRequest('INVALID_ID', 'The user id has an invalid format.');
  }

  const target = await userStore.findById(id);
  // Absent, or present but outside the actor's jurisdiction: the same answer
  // either way, so the reply reveals nothing about which it was.
  if (target === null || !canAccess(actor, 'user:read', target)) {
    throw HttpError.notFound('USER_NOT_FOUND', 'No such user.');
  }
  return target;
}

/**
 * @param {object} actor The signed-in user.
 * @returns {Promise<object[]>} users within the actor's jurisdiction.
 * @throws {HttpError} 403 FORBIDDEN.
 */
export async function listUsers(actor) {
  if (!canAccess(actor, 'user:list')) {
    throw HttpError.forbidden('FORBIDDEN', 'You are not allowed to list users.');
  }

  const scope = scopeFor(actor, 'user:list');
  return scope.kind === 'all' ? userStore.listAll() : userStore.listByTeacher(scope.userId);
}

/**
 * Create a teacher or a student.
 *
 * Order of checks is deliberate: authorization runs before validation, so an
 * actor who may not create users learns nothing about what the rules for a
 * valid username are.
 *
 * @param {object} actor
 * @param {object} payload {username, password, role, teacherId?}
 * @returns {Promise<object>} the created user.
 * @throws {HttpError} 400 | 403 | 409.
 */
export async function createUser(actor, payload = {}) {
  const role = payload.role;
  if (!CREATABLE_ROLES.includes(role)) {
    throw HttpError.badRequest(
      'INVALID_ROLE',
      'A new account must be a teacher or a student. Administrators are created only by server configuration.'
    );
  }

  // A teacher's students are always their own — the client does not get to
  // nominate someone else's. An admin must say which teacher, because a
  // student without one would break the hierarchy the whole model rests on.
  let teacherId = null;
  if (role === 'student') {
    teacherId = actor?.role === 'teacher' ? actor.id : payload.teacherId ?? null;
  }

  if (!canAccess(actor, 'user:create', { role, teacherId })) {
    throw HttpError.forbidden('FORBIDDEN', 'You are not allowed to create this kind of account.');
  }

  const username = normaliseUsername(payload.username);
  assertPasswordPolicy(payload.password);

  if (role === 'student') {
    const teacher = teacherId === null ? null : await userStore.findById(teacherId);
    if (teacher === null || teacher.role !== 'teacher') {
      throw HttpError.badRequest(
        'TEACHER_REQUIRED',
        'A student must be assigned to an existing teacher.'
      );
    }
  }

  const passwordHash = await hashPassword(payload.password);

  try {
    return await userStore.insert({ username, passwordHash, role, teacherId });
  } catch (err) {
    // Both the plain UNIQUE constraint and users_username_lower_key raise
    // this; either way the name is taken.
    if (err?.code === UNIQUE_VIOLATION) {
      throw HttpError.conflict('USERNAME_TAKEN', 'That username is already in use.');
    }
    throw err;
  }
}

/**
 * @param {object} actor
 * @param {*} id Target user id.
 * @returns {Promise<void>}
 * @throws {HttpError} 400 | 403 | 404.
 */
export async function deleteUser(actor, id) {
  const target = await requireVisibleUser(actor, id);

  if (!canAccess(actor, 'user:delete', target)) {
    throw HttpError.forbidden(
      'FORBIDDEN',
      target.id === actor.id
        ? 'You cannot delete your own account.'
        : 'You are not allowed to delete this user.'
    );
  }

  await userStore.remove(target.id);
}

/**
 * Set someone else's password, for the case where they have forgotten it.
 * Every session they hold is closed, because the point of a reset is that the
 * old credential stops working.
 *
 * @param {object} actor
 * @param {*} id Target user id.
 * @param {*} newPassword
 * @returns {Promise<void>}
 * @throws {HttpError} 400 | 403 | 404.
 */
export async function resetPassword(actor, id, newPassword) {
  const target = await requireVisibleUser(actor, id);

  if (!canAccess(actor, 'user:resetPassword', target)) {
    throw HttpError.forbidden('FORBIDDEN', 'You are not allowed to reset this password.');
  }

  assertPasswordPolicy(newPassword);
  await userStore.updatePasswordHash(target.id, await hashPassword(newPassword));
  await sessionStore.removeAllForUser(target.id);
}

/**
 * Generate a password suggestion for the create/reset dialogs. Kept here
 * rather than in the browser so the suggestion comes from a CSPRNG that is
 * not subject to whatever the client happens to be.
 *
 * @returns {string} a 16-character password from an unambiguous alphabet
 *          (no O/0, l/1 — these get read aloud and written on paper).
 */
export function suggestPassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}
