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
 *     - ownerId IS part of the document, added deliberately (not by a stray
 *       SELECT *) when accounts arrived: the browser needs it to tell "mine"
 *       from "my student's" without a second request. ownerTeacherId is NOT —
 *       it is returned beside the document, for the service to authorize on,
 *       and never reaches a client.
 *
 *   Ownership filtering:
 *     Reads and writes take a scope produced by scopeFor() in
 *     services/userService.js — this module never decides who may see what,
 *     it only applies the filter it is handed. The service checks canAccess()
 *     as well, so an owner predicate here is a SECOND lock rather than the
 *     only one; it closes the gap between reading a row to authorize it and
 *     writing it a moment later.
 */

import crypto from 'node:crypto';

import { query } from './db.js';

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
            owner_id,
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
    ownerId: row.owner_id,
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

/**
 * Build the WHERE fragment for a listing, from a scope descriptor.
 *
 * Returns the SQL and the bound values so the caller cannot accidentally get
 * the placeholder numbering wrong. 'none' yields a predicate that is false
 * for every row rather than an empty one: a scope the policy refused must
 * return nothing, and "no filter" would return everything.
 *
 * @param {{kind: string, userId: string|null}} scope From userService.scopeFor().
 * @param {string} column The qualified owner column ('owner_id' or 'g.owner_id').
 *        A fixed argument chosen by this module — never anything client-supplied.
 * @returns {{where: string, values: Array}}
 */
function scopeClause(scope, column) {
  switch (scope?.kind) {
    case 'all':
      return { where: '', values: [] };
    case 'self':
      return { where: `WHERE ${column} = $1`, values: [scope.userId] };
    case 'self-and-students':
      return {
        where: `WHERE ${column} = $1 OR ${column} IN (SELECT id FROM users WHERE teacher_id = $1)`,
        values: [scope.userId],
      };
    default:
      return { where: 'WHERE false', values: [] };
  }
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
 * List the stored grammars visible under `scope` as lightweight metadata (the
 * full production list stays in the database), newest first.
 *
 * The owner's username travels with each row so the browser can label a
 * teacher's view of a student's work without a request per grammar.
 *
 * @param {{kind: string, userId: string|null}} scope From userService.scopeFor().
 */
export async function list(scope) {
  const { where, values } = scopeClause(scope, 'g.owner_id');

  const { rows } = await query(
    `SELECT g.id,
            g.owner_id,
            owner.username                    AS owner_username,
            g.name,
            COALESCE(g.description, '')       AS description,
            jsonb_array_length(g.variables)   AS variable_count,
            jsonb_array_length(g.terminals)   AS terminal_count,
            jsonb_array_length(g.productions) AS production_count,
            g.created_at,
            g.updated_at
       FROM grammars g
       JOIN users owner ON owner.id = g.owner_id
      ${where}
      ORDER BY g.updated_at DESC, g.id DESC`,
    values
  );

  return rows.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    ownerUsername: row.owner_username,
    name: row.name,
    description: row.description ?? '',
    variableCount: row.variable_count,
    terminalCount: row.terminal_count,
    productionCount: row.production_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * Fetch one grammar together with what is needed to authorize access to it.
 *
 * The owner descriptor is returned SEPARATELY from the document rather than
 * folded into it: ownerTeacherId is nobody's business but the authorization
 * check's, and a field that never enters the document can never be
 * serialised to a client by accident.
 *
 * @returns {Promise<{document: object, owner: {id: string, username: string, teacherId: string|null}}|null>}
 *          null if absent.
 */
export async function get(id) {
  const uuid = asUuid(id);
  if (uuid === null) return null;

  const { rows } = await query(
    `SELECT g.id,
            g.owner_id,
            g.name,
            COALESCE(g.description, '') AS description,
            g.variables,
            g.terminals,
            g.start_symbol,
            g.productions,
            g.created_at,
            g.updated_at,
            owner.username   AS owner_username,
            owner.teacher_id AS owner_teacher_id
       FROM grammars g
       JOIN users owner ON owner.id = g.owner_id
      WHERE g.id = $1`,
    [uuid]
  );

  if (rows.length === 0) return null;
  const row = rows[0];

  return {
    document: toDocument(row),
    owner: {
      id: row.owner_id,
      username: row.owner_username,
      teacherId: row.owner_teacher_id,
    },
  };
}

/**
 * Persist a new grammar owned by `ownerId`.
 *
 * Before accounts existed this resolved the owner with a sub-select over the
 * administrators, and failed loudly when there were none. Both are gone: a
 * grammar can only be saved through a session now, so there is always a real
 * owner and the "server not configured" case cannot arise.
 *
 * @param {object} grammar A normalized grammar (the service validated it).
 * @param {string} ownerId The signed-in user saving it.
 * @returns {Promise<object>} the stored document — the grammar plus
 *          { id: randomUUID, ownerId, createdAt, updatedAt } (ISO timestamps).
 */
export async function create(grammar, ownerId) {
  const { rows } = await query(
    `INSERT INTO grammars (id, owner_id, name, description, variables, terminals, start_symbol, productions)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb)
     RETURNING ${DOCUMENT_COLUMNS}`,
    [crypto.randomUUID(), ownerId, ...grammarValues(grammar)]
  );

  return toDocument(rows[0]);
}

/**
 * Replace the grammar content of an existing document. id, createdAt and
 * ownership are preserved by never appearing in the SET list; updatedAt is
 * bumped.
 *
 * `ownerId` is an optional second lock. The service has already checked
 * canAccess() against the row it read a moment ago; adding the owner to the
 * WHERE makes the write itself conditional, so a row that changed hands in
 * between is not overwritten on the strength of a stale read. An admin passes
 * nothing, because they may edit any grammar.
 *
 * @param {string} id
 * @param {object} grammar
 * @param {{ownerId?: string}} [guard]
 * @returns {Promise<object|null>} the updated document, or null if absent or
 *          not matching the guard.
 */
export async function update(id, grammar, { ownerId } = {}) {
  const uuid = asUuid(id);
  if (uuid === null) return null;

  const values = [uuid, ...grammarValues(grammar)];
  let ownerPredicate = '';
  if (ownerId !== undefined) {
    values.push(ownerId);
    ownerPredicate = ` AND owner_id = $${values.length}`;
  }

  const { rows } = await query(
    `UPDATE grammars
        SET name         = $2,
            description  = $3,
            variables    = $4::jsonb,
            terminals    = $5::jsonb,
            start_symbol = $6,
            productions  = $7::jsonb,
            updated_at   = now()
      WHERE id = $1${ownerPredicate}
     RETURNING ${DOCUMENT_COLUMNS}`,
    values
  );

  return rows.length === 0 ? null : toDocument(rows[0]);
}

/**
 * @param {string} id
 * @param {{ownerId?: string}} [guard] Same second lock as update().
 * @returns {Promise<boolean>} true if a document was deleted.
 */
export async function remove(id, { ownerId } = {}) {
  const uuid = asUuid(id);
  if (uuid === null) return false;

  const values = [uuid];
  let ownerPredicate = '';
  if (ownerId !== undefined) {
    values.push(ownerId);
    ownerPredicate = ` AND owner_id = $${values.length}`;
  }

  const { rowCount } = await query(
    `DELETE FROM grammars WHERE id = $1${ownerPredicate}`,
    values
  );
  return rowCount > 0;
}
