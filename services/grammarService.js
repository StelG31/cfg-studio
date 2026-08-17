/**
 * services/grammarService.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Business rules around stored grammars. Controllers call this layer;
 *   this layer calls the store (models/grammarStore.js) and the shared
 *   algorithm core. Rules enforced here:
 *
 *     - only VALID grammars may be persisted (the shared validator runs
 *       server-side before every create/update — the client cannot bypass
 *       it). Unfinished work belongs to the editor's local draft, the
 *       server keeps only grammars that algorithms can actually run on.
 *     - names are trimmed and capped, ids are shape-checked before any
 *       filesystem access.
 *     - every operation is authorized against the signed-in user, which is
 *       why each one takes `actor` as its first argument. The decision itself
 *       is never made here: it is delegated to canAccess() in
 *       services/userService.js, the single authorization function.
 *
 *   Who may see what:
 *     a student sees only their own grammars; a teacher additionally sees —
 *     but cannot modify — everything their own students saved; an admin sees
 *     everything. Read and write are asymmetric on purpose: a student's work
 *     stays theirs, which is the point of showing it to a teacher at all.
 *
 *   Sample grammars (data/samples.json) are read-only: they ship with the
 *   application, are loaded once and served from memory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from '../models/grammarStore.js';
import { validateGrammar } from '../core/validator.js';
import { parseGrammarPayload } from './computeService.js';
import { canAccess, scopeFor } from './userService.js';
import { HttpError } from '../utils/httpError.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_PATH = path.join(__dirname, '..', 'data', 'samples.json');

const NAME_MAX_LENGTH = 100;

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Parse + validate an incoming grammar payload for persistence.
 * Throws 400 with the full finding list when the grammar is invalid, so
 * the client can show exactly what to fix.
 *
 * Side benefit worth knowing: parseGrammarPayload funnels the payload
 * through createGrammar, which rebuilds the object field by field — any
 * unexpected extra keys a client sends are silently STRIPPED before the
 * document reaches the store.
 *
 * @param {*} payload Grammar payload (bare or enveloped).
 * @returns {object} a normalized, validator-clean grammar (name capped).
 * @throws {HttpError} 400 GRAMMAR_INVALID (details.errors = findings).
 */
function requireValidGrammar(payload) {
  const grammar = parseGrammarPayload(payload);

  const result = validateGrammar(grammar);
  if (!result.valid) {
    throw HttpError.badRequest(
      'GRAMMAR_INVALID',
      'Only valid grammars can be saved — fix the reported problems first.',
      { errors: result.errors }
    );
  }

  grammar.name = grammar.name.slice(0, NAME_MAX_LENGTH);
  return grammar;
}

/**
 * Reject ill-shaped ids BEFORE any filesystem access — combined with the
 * store's own check this is the double lock against path traversal.
 *
 * @param {string} id Candidate document id from the URL.
 * @returns {string} the same id, now known to be UUID-shaped.
 * @throws {HttpError} 400 INVALID_ID.
 */
function requireId(id) {
  if (!store.isValidId(id)) {
    throw HttpError.badRequest('INVALID_ID', 'The grammar id has an invalid format.');
  }
  return id;
}

/** The answer for "absent" AND for "exists, but not yours to know about". */
function notFound() {
  return HttpError.notFound('GRAMMAR_NOT_FOUND', 'No saved grammar exists with this id.');
}

/**
 * Fetch a grammar and settle, once, whether the actor may know it exists.
 *
 * The 404-before-403 rule lives here rather than in each caller: a grammar
 * the actor cannot READ is reported exactly as an absent one, so the two
 * cases are indistinguishable and a probe cannot discover which grammar ids
 * are real. Only for a grammar they can see does a refusal admit to being a
 * refusal.
 *
 * @param {object} actor The signed-in user.
 * @param {string} id Document id from the URL.
 * @returns {Promise<{document: object, target: {ownerId: string, ownerTeacherId: string|null}}>}
 * @throws {HttpError} 400 INVALID_ID | 404 GRAMMAR_NOT_FOUND.
 */
async function requireReadableGrammar(actor, id) {
  const found = await store.get(requireId(id));
  if (found === null) throw notFound();

  const target = { ownerId: found.owner.id, ownerTeacherId: found.owner.teacherId };
  if (!canAccess(actor, 'grammar:read', target)) throw notFound();

  return { document: found.document, owner: found.owner, target };
}

/**
 * The owner predicate the store applies as a second lock on a write. An admin
 * may write any row, so they are given no predicate; everyone else may only
 * write their own, which is exactly what canAccess just agreed to.
 */
function writeGuard(actor) {
  return actor.role === 'admin' ? {} : { ownerId: actor.id };
}

/* ------------------------------------------------------------------------ */
/* Stored grammars                                                           */
/* ------------------------------------------------------------------------ */

/**
 * @param {object} actor The signed-in user.
 * @returns {Promise<object[]>} metadata for the grammars within the actor's
 *          jurisdiction, newest first.
 */
export async function listGrammars(actor) {
  return store.list(scopeFor(actor, 'grammar:read'));
}

/**
 * @param {object} actor The signed-in user.
 * @param {string} id Document id from the URL.
 * @returns {Promise<object>} the full stored document, plus ownerUsername so
 *          a teacher opening a student's grammar can be told whose it is.
 *          (create and update do not carry it: there the owner is either the
 *          caller or already known to them, and adding it would mean a join
 *          on the write path for a label nothing reads.)
 * @throws {HttpError} 400 INVALID_ID | 404 GRAMMAR_NOT_FOUND.
 */
export async function getGrammar(actor, id) {
  const { document, owner } = await requireReadableGrammar(actor, id);
  return { ...document, ownerUsername: owner.username };
}

/**
 * @param {object} actor The signed-in user, who becomes the owner.
 * @param {*} payload Grammar payload; must pass the shared validator.
 * @returns {Promise<object>} the stored document (id + timestamps added).
 * @throws {HttpError} 400 GRAMMAR_INVALID and the parse-stage 400s | 403.
 */
export async function createGrammar(actor, payload) {
  if (!canAccess(actor, 'grammar:create')) {
    throw HttpError.forbidden('FORBIDDEN', 'You are not allowed to save grammars.');
  }
  return store.create(requireValidGrammar(payload), actor.id);
}

/**
 * @param {object} actor The signed-in user.
 * @param {string} id Existing document id.
 * @param {*} payload Replacement grammar; same validation as create.
 * @returns {Promise<object>} the updated document (updatedAt bumped).
 * @throws {HttpError} 400 | 403 FORBIDDEN | 404 GRAMMAR_NOT_FOUND.
 */
export async function updateGrammar(actor, id, payload) {
  const { target } = await requireReadableGrammar(actor, id);

  // Reached only for a grammar the actor can see, so 403 gives nothing away —
  // and telling a teacher "this is your student's, you may read it but not
  // change it" is far more useful than pretending it does not exist.
  if (!canAccess(actor, 'grammar:update', target)) {
    throw HttpError.forbidden('FORBIDDEN', 'You are not allowed to modify this grammar.');
  }

  const doc = await store.update(id, requireValidGrammar(payload), writeGuard(actor));
  if (doc === null) throw notFound();
  return doc;
}

/**
 * @param {object} actor The signed-in user.
 * @param {string} id Document id to delete.
 * @returns {Promise<void>} resolves on success (controller answers 204).
 * @throws {HttpError} 400 INVALID_ID | 403 FORBIDDEN | 404 GRAMMAR_NOT_FOUND.
 */
export async function deleteGrammar(actor, id) {
  const { target } = await requireReadableGrammar(actor, id);

  if (!canAccess(actor, 'grammar:delete', target)) {
    throw HttpError.forbidden('FORBIDDEN', 'You are not allowed to delete this grammar.');
  }

  if (!(await store.remove(id, writeGuard(actor)))) throw notFound();
}

/* ------------------------------------------------------------------------ */
/* Sample grammars (read-only, shipped with the app)                         */
/* ------------------------------------------------------------------------ */

let samplesCache = null;

/**
 * The built-in samples, loaded from disk once per process and served from
 * memory thereafter. Never invalidated on purpose: the file only changes
 * with a redeploy, which restarts the process anyway.
 *
 * @returns {Promise<object[]>} the sample grammars (with testStrings).
 */
export async function listExamples() {
  if (samplesCache === null) {
    const raw = await fs.readFile(SAMPLES_PATH, 'utf8');
    samplesCache = JSON.parse(raw);
  }
  return samplesCache;
}
