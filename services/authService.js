/**
 * services/authService.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Signing in, signing out, resolving a cookie to a user, and changing your
 *   own password. Everything about credentials in one place.
 *
 *   THE TOKEN AND ITS HASH — the single most important thing in this file:
 *
 *     A session token is a bearer credential. Whoever reads it IS the user it
 *     belongs to; no password is needed afterwards. So the token exists in
 *     exactly two places — the browser's cookie, and a local variable during
 *     the request that created it — and what goes into the database is
 *     sha256(token). A leak of the sessions table then yields nothing usable:
 *     an attacker holding the digests still cannot produce a cookie, because
 *     that would mean inverting SHA-256.
 *
 *     SHA-256 rather than scrypt, which is the opposite of the choice made
 *     for passwords, and for a reason that is worth being explicit about. A
 *     slow KDF exists to make GUESSING expensive. Passwords are guessable —
 *     people pick words. A token is 256 bits from a CSPRNG and cannot be
 *     guessed at any speed, so a deliberately slow hash would buy nothing and
 *     cost a scrypt run on every single authenticated request.
 *
 *   Layering note: this service reaches into two stores (users and sessions)
 *   because a login is precisely the operation that joins them. Neither store
 *   knows the other exists.
 */

import crypto from 'node:crypto';

import * as userStore from '../models/userStore.js';
import * as sessionStore from '../models/sessionStore.js';
import * as userService from './userService.js';
import { hashPassword, verifyPassword, needsRehash } from '../utils/password.js';
import { HttpError } from '../utils/httpError.js';
import { SESSION_TTL_MS } from '../utils/sessionCookie.js';

/** 256 bits — far beyond anything brute force reaches. */
const TOKEN_BYTES = 32;

/** base64url so the value needs no escaping in a Set-Cookie header. */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The value stored in sessions.id. Hex, lower case, 64 characters — exactly
 * what the sessions_id_is_sha256 CHECK constraint demands.
 *
 * @param {string} token Raw session token.
 * @returns {string} its SHA-256, hex-encoded.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * A real scrypt hash of a random string, used to answer failed logins for
 * usernames that do not exist.
 *
 * Without it, an unknown username returns immediately while a known one waits
 * for scrypt — a timing difference big enough to read over a network, which
 * turns the login form into a way to enumerate who has an account. Verifying
 * against this makes both paths do the same work.
 *
 * Built once, lazily: it costs one scrypt run on the first failed login of
 * the process rather than delaying every startup.
 */
let dummyHashPromise = null;
function dummyHash() {
  if (dummyHashPromise === null) {
    dummyHashPromise = hashPassword(crypto.randomBytes(24).toString('hex'));
  }
  return dummyHashPromise;
}

/** One message for every failure, so the reply never says which part was wrong. */
function invalidCredentials() {
  return HttpError.unauthorized('INVALID_CREDENTIALS', 'Incorrect username or password.');
}

/* ------------------------------------------------------------------------ */
/* Sessions                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Open a session for a user who has already been authenticated.
 *
 * @param {string} userId
 * @returns {Promise<{token: string, expiresAt: string}>} the RAW token, which
 *          the caller must put in a cookie and then forget.
 */
async function openSession(userId) {
  const token = generateToken();
  const { expiresAt } = await sessionStore.create(hashToken(token), userId, SESSION_TTL_MS);
  return { token, expiresAt };
}

/**
 * Sign in.
 *
 * @param {*} username Raw username from the client (matched case-insensitively).
 * @param {*} password Raw password.
 * @returns {Promise<{user: object, token: string, expiresAt: string}>}
 * @throws {HttpError} 401 INVALID_CREDENTIALS — for a wrong password AND for
 *         an unknown user, deliberately indistinguishable.
 */
export async function login(username, password) {
  if (typeof password !== 'string' || password === '') {
    // Still not a distinct code: an empty password is a failed login like any
    // other, and saying otherwise would confirm the username was checked.
    throw invalidCredentials();
  }

  const found = await userStore.findCredentialsByUsername(
    typeof username === 'string' ? username.trim() : ''
  );

  if (found === null) {
    await verifyPassword(password, await dummyHash()); // equalise the timing
    throw invalidCredentials();
  }

  if (!(await verifyPassword(password, found.passwordHash))) {
    throw invalidCredentials();
  }

  // The cost of hashing has to rise over the years, and a successful sign-in
  // is the only moment the plaintext is available to re-hash with today's
  // parameters. See utils/password.js.
  if (needsRehash(found.passwordHash)) {
    await userStore.updatePasswordHash(found.user.id, await hashPassword(password));
  }

  // Housekeeping on a path that is already doing slow work, rather than a
  // background timer that every instance would run in parallel.
  await sessionStore.deleteExpired();

  const { token, expiresAt } = await openSession(found.user.id);
  return { user: found.user, token, expiresAt };
}

/**
 * Sign out. Deleting the row is what makes this real: the cookie may linger
 * in a browser, but it no longer names anything.
 *
 * @param {string|null} token Raw session token from the cookie.
 * @returns {Promise<void>}
 */
export async function logout(token) {
  if (typeof token !== 'string' || token === '') return;
  await sessionStore.remove(hashToken(token));
}

/**
 * Resolve a cookie to the user it belongs to.
 *
 * @param {string|null} token Raw session token.
 * @returns {Promise<object|null>} the signed-in user, or null for an absent,
 *          unknown, tampered or expired token — all the same answer, because
 *          the caller's response to each is identical.
 */
export async function resolveSession(token) {
  if (typeof token !== 'string' || token === '') return null;
  return sessionStore.findValid(hashToken(token));
}

/* ------------------------------------------------------------------------ */
/* Password change (self-service)                                            */
/* ------------------------------------------------------------------------ */

/**
 * Change your own password, proving you know the current one.
 *
 * Every existing session is closed and a fresh one opened, so the device
 * doing the change stays signed in while every other one is turned out. That
 * is the behaviour someone changing a password because they fear it leaked
 * actually wants.
 *
 * @param {object} actor The signed-in user.
 * @param {*} currentPassword
 * @param {*} newPassword
 * @returns {Promise<{token: string, expiresAt: string}>} a replacement session.
 * @throws {HttpError} 400 WEAK_PASSWORD | 401 INVALID_CREDENTIALS | 403.
 */
export async function changeOwnPassword(actor, currentPassword, newPassword) {
  if (!userService.canAccess(actor, 'user:changeOwnPassword', { id: actor?.id })) {
    throw HttpError.forbidden('FORBIDDEN', 'You may only change your own password.');
  }

  const found = await userStore.findCredentialsById(actor.id);
  if (found === null) {
    // The account was deleted while this request was in flight.
    throw HttpError.unauthorized('UNAUTHENTICATED', 'Your account no longer exists.');
  }

  if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, found.passwordHash))) {
    throw invalidCredentials();
  }

  userService.assertPasswordPolicy(newPassword);

  await userStore.updatePasswordHash(actor.id, await hashPassword(newPassword));
  await sessionStore.removeAllForUser(actor.id);

  return openSession(actor.id);
}
