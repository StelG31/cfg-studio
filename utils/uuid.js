/**
 * utils/uuid.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Recognise the strings a `uuid` column will actually accept.
 *
 *   Every store that takes an id from a URL needs this guard, because
 *   PostgreSQL raises 22P02 for a malformed uuid literal — a database error
 *   for what is really a client mistake. Filtering first turns "that cannot
 *   name a row" into the store's ordinary "no such row" answer.
 *
 *   models/grammarStore.js keeps its own looser isValidId(): its behaviour is
 *   part of an existing API contract (it decides 400 INVALID_ID) and
 *   tightening it would turn today's 404 into a 400.
 */

/** The RFC-4122 layout, which is what a uuid column will take. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {*} value Candidate id.
 * @returns {boolean} true when a uuid column could hold it.
 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * @param {*} value Candidate id.
 * @returns {string|null} the id, or null when no row could ever carry it.
 */
export function asUuid(value) {
  return isUuid(value) ? value : null;
}
