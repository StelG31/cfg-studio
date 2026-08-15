/**
 * utils/password.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Turn a plaintext password into a string safe to store, and check a
 *   candidate password against such a string.
 *
 *   Stored format — self-describing, single line:
 *     scrypt$N=16384,r=8,p=1,len=64$<salt base64url>$<hash base64url>
 *
 *   Why scrypt from node:crypto and not bcrypt or argon2: both of those are
 *   native addons needing node-gyp and a C++ toolchain. A reviewer cloning
 *   this project must never hit a compiler error, so every dependency here
 *   is pure JavaScript or built into Node. scrypt is memory-hard and an
 *   accepted password-hashing KDF, so nothing is given up for that.
 *
 *   Why the parameters travel WITH the hash instead of being constants: the
 *   cost of hashing has to rise over the years. A self-describing hash can
 *   always be verified with the parameters it was created with, while new
 *   hashes use the current ones — so raising the cost never invalidates
 *   stored passwords. needsRehash() marks the ones due for an upgrade on
 *   their owner's next successful sign-in.
 *
 *   Only hashPassword() is used in this phase; the rest exists so the
 *   authentication phase does not have to reopen this file.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;

/** Current cost. Raise N over time; never lower it. */
const CURRENT = Object.freeze({ N: 16384, r: 8, p: 1, len: 64 });

/**
 * scrypt needs roughly 128 * N * r bytes and Node caps it at 32 MiB by
 * default — N=32768 already exceeds that and throws. Deriving the ceiling
 * from the parameters means a future cost increase cannot break hashing or
 * the verification of hashes made with today's settings.
 */
function maxmemFor({ N, r }) {
  return Math.max(32 * 1024 * 1024, 256 * N * r);
}

function encodeParams({ N, r, p, len }) {
  return `N=${N},r=${r},p=${p},len=${len}`;
}

/**
 * Parse the parameter segment back out of a stored hash.
 *
 * @param {string} text The "N=...,r=...,p=...,len=..." segment.
 * @returns {{N: number, r: number, p: number, len: number}|null} null when
 *          malformed or implausible.
 */
function decodeParams(text) {
  const parsed = {};
  for (const pair of text.split(',')) {
    const [key, value] = pair.split('=');
    parsed[key] = Number(value);
  }

  const { N, r, p, len } = parsed;
  if (![N, r, p, len].every((n) => Number.isInteger(n) && n > 0)) return null;
  // A corrupt or hostile row must not turn one login attempt into a
  // multi-gigabyte allocation.
  if (N > 2 ** 20 || r > 32 || p > 16 || len > 128) return null;
  if ((N & (N - 1)) !== 0) return null; // scrypt requires N to be a power of two
  return { N, r, p, len };
}

/**
 * @param {string} password Plaintext password.
 * @param {object} [params] Cost parameters; defaults to the current settings.
 * @returns {Promise<string>} the value to store in users.password_hash.
 */
export async function hashPassword(password, params = CURRENT) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, params.len, {
    ...params, // crypto.scrypt ignores unknown keys such as len
    maxmem: maxmemFor(params),
  });

  return [
    ALGORITHM,
    encodeParams(params),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Check a candidate password against a stored hash.
 *
 * @param {string} password Candidate plaintext.
 * @param {string} stored   Value from users.password_hash.
 * @returns {Promise<boolean>} false — never a throw — for any unusable row,
 *          so a corrupt hash denies access instead of crashing a request.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;

  const params = decodeParams(parts[1]);
  if (params === null) return false;

  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  // timingSafeEqual throws on a length mismatch, so lengths are settled here
  // rather than inside the comparison.
  if (salt.length === 0 || expected.length !== params.len) return false;

  const actual = await scryptAsync(password, salt, params.len, {
    ...params,
    maxmem: maxmemFor(params),
  });
  return timingSafeEqual(actual, expected);
}

/**
 * @param {string} stored Value from users.password_hash.
 * @returns {boolean} true when the hash is unusable or was made with weaker
 *          parameters than the current ones.
 */
export function needsRehash(stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return true;

  const params = decodeParams(parts[1]);
  if (params === null) return true;
  return params.N < CURRENT.N || params.r < CURRENT.r || params.len < CURRENT.len;
}
