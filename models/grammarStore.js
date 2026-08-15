/**
 * models/grammarStore.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The persistence layer of CFG Studio: one row per saved grammar in the
 *   PostgreSQL `grammars` table. This is the ONLY module in the project that
 *   issues SQL for user data — the layers above it (services, controllers,
 *   routes) were not touched when storage moved off JSON files, because the
 *   exported interface below is exactly the one they already used. That is
 *   the whole point of keeping persistence behind a single module.
 *
 *   Design notes:
 *     - Documents are plain camelCase objects whose timestamps are ISO-8601
 *       STRINGS. pg hands back TIMESTAMPTZ as a Date, so toDocument() is the
 *       one place that conversion happens. This matters more than it looks:
 *       Date.prototype.toJSON also emits an ISO string, so a missed
 *       conversion is invisible over HTTP and only surfaces when someone
 *       sorts or slices a timestamp.
 *     - Every JSONB parameter is JSON.stringify()d first. pg serialises a JS
 *       array as a PostgreSQL array literal ({"a","b"}), which a jsonb
 *       column rejects — arrays are the one type that does NOT round-trip
 *       by itself.
 *     - list() computes its counts with jsonb_array_length() server-side, so
 *       production lists never leave the database just to be counted.
 *     - Timestamps come from now() rather than from Node: the database is a
 *       single clock for every instance, and its microsecond resolution
 *       keeps rapid consecutive saves from tying in the ordering.
 *     - test_strings is never selected. The column exists for the phase that
 *       will use it, but the document contract has no such field, so a
 *       SELECT * here would silently add a key to every document.
 */

import crypto from 'node:crypto';

import { query } from './db.js';
import { HttpError } from '../utils/httpError.js';

/** UUIDs (and nothing else) are acceptable document ids. */
const ID_PATTERN = /^[a-f0-9-]{36}$/i;

/** The real RFC-4122 layout, which is what a uuid column will actually take. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape-check an id. The service calls this to decide 400 INVALID_ID, so its
 * behaviour is part of the public API contract and must not change.
 *
 * @param {*} id Candidate id.
 * @returns {boolean}
 */
export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/**
 * Narrow an id to something a uuid column will accept.
 *
 * isValidId() is deliberately loose — it has always accepted strings such as
 * 36 dashes, and tightening it would turn today's 404 into a 400. Postgres is
 * stricter and raises 22P02 for those, so they are filtered out here instead:
 * an id that cannot be a UUID cannot name a row, which is exactly the
 * "absent" answer the interface already promises.
 *
 * Catching 22P02 instead would be a mistake worth remembering: a JSONB
 * parameter that was not stringified raises the very same code, so a broken
 * save would be reported to the user as "not found".
 *
 * @param {*} id Candidate id.
 * @returns {string|null} the id, or null if no row could ever carry it.
 */
function asUuid(id) {
  return isValidId(id) && UUID_PATTERN.test(id) ? id : null;
}

/** The columns every full-document read returns, in interface order. */
const DOCUMENT_COLUMNS = `id,
            name,
            COALESCE(description, '') AS description,
            variables,
            terminals,
            start_symbol,
            productions,
            created_at,
            updated_at`;

/**
 * Map a row onto the stored-document shape. Key order reproduces the old
 * { id, ...grammar, createdAt, updatedAt } spread, so the serialised JSON is
 * unchanged from the JSON-file era.
 */
function toDocument(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    variables: row.variables,
    terminals: row.terminals,
    startSymbol: row.start_symbol,
    productions: row.productions,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The bound parameters shared by create() and update(), after the id. */
function grammarValues(grammar) {
  return [
    grammar.name,
    grammar.description,
    JSON.stringify(grammar.variables),
    JSON.stringify(grammar.terminals),
    grammar.startSymbol,
    JSON.stringify(grammar.productions),
  ];
}

/* ------------------------------------------------------------------------ */
/* CRUD interface                                                            */
/* ------------------------------------------------------------------------ */

/**
 * List every stored grammar as lightweight metadata (the full production
 * list stays in the database), newest first.
 */
export async function list() {
  const { rows } = await query(
    `SELECT id,
            name,
            COALESCE(description, '')       AS description,
            jsonb_array_length(variables)   AS variable_count,
            jsonb_array_length(terminals)   AS terminal_count,
            jsonb_array_length(productions) AS production_count,
            created_at,
            updated_at
       FROM grammars
      ORDER BY updated_at DESC, id DESC`
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    variableCount: row.variable_count,
    terminalCount: row.terminal_count,
    productionCount: row.production_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/** @returns {Promise<object|null>} the full document, or null if absent. */
export async function get(id) {
  const uuid = asUuid(id);
  if (uuid === null) return null;

  const { rows } = await query(`SELECT ${DOCUMENT_COLUMNS} FROM grammars WHERE id = $1`, [uuid]);
  return rows.length === 0 ? null : toDocument(rows[0]);
}

/**
 * Persist a new grammar, owned by the bootstrap administrator.
 *
 * Ownership is resolved in the same statement rather than in a prior query:
 * one round trip, and no chance of the owner disappearing between the two.
 * Until the authentication phase lands there is no per-request user, so
 * every grammar belongs to the administrator.
 *
 * @param {object} grammar A normalized grammar (the service validated it).
 * @returns {Promise<object>} the stored document — the grammar plus
 *          { id: randomUUID, createdAt, updatedAt } (ISO timestamps).
 * @throws {HttpError} 503 SERVER_NOT_CONFIGURED when no administrator exists.
 */
export async function create(grammar) {
  const { rows } = await query(
    `INSERT INTO grammars (id, owner_id, name, description, variables, terminals, start_symbol, productions)
     SELECT $1, u.id, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb
       FROM users u
      WHERE u.role = 'admin'
      ORDER BY u.created_at, u.id
      LIMIT 1
     RETURNING ${DOCUMENT_COLUMNS}`,
    [crypto.randomUUID(), ...grammarValues(grammar)]
  );

  // No administrator means the sub-select matched nothing, so the INSERT
  // stored nothing — and said so silently. Reporting that as success would
  // lose the grammar, so it becomes an explicit, actionable failure.
  if (rows.length === 0) {
    throw HttpError.serviceUnavailable(
      'SERVER_NOT_CONFIGURED',
      'The server has no administrator account yet, so grammars cannot be saved. ' +
        'Set ADMIN_USERNAME and ADMIN_PASSWORD and restart the server.'
    );
  }

  return toDocument(rows[0]);
}

/**
 * Replace the grammar content of an existing document. id, createdAt and
 * ownership are preserved by never appearing in the SET list; updatedAt is
 * bumped.
 *
 * @returns {Promise<object|null>} the updated document, or null if absent.
 */
export async function update(id, grammar) {
  const uuid = asUuid(id);
  if (uuid === null) return null;

  const { rows } = await query(
    `UPDATE grammars
        SET name         = $2,
            description  = $3,
            variables    = $4::jsonb,
            terminals    = $5::jsonb,
            start_symbol = $6,
            productions  = $7::jsonb,
            updated_at   = now()
      WHERE id = $1
     RETURNING ${DOCUMENT_COLUMNS}`,
    [uuid, ...grammarValues(grammar)]
  );

  return rows.length === 0 ? null : toDocument(rows[0]);
}

/** @returns {Promise<boolean>} true if a document was deleted. */
export async function remove(id) {
  const uuid = asUuid(id);
  if (uuid === null) return false;

  const { rowCount } = await query('DELETE FROM grammars WHERE id = $1', [uuid]);
  return rowCount > 0;
}
