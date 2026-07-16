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

/* ------------------------------------------------------------------------ */
/* Stored grammars                                                           */
/* ------------------------------------------------------------------------ */

/** @returns {Promise<object[]>} stored-grammar metadata, newest first. */
export async function listGrammars() {
  return store.list();
}

/**
 * @param {string} id Document id from the URL.
 * @returns {Promise<object>} the full stored document.
 * @throws {HttpError} 400 INVALID_ID | 404 GRAMMAR_NOT_FOUND.
 */
export async function getGrammar(id) {
  const doc = await store.get(requireId(id));
  if (doc === null) {
    throw HttpError.notFound('GRAMMAR_NOT_FOUND', 'No saved grammar exists with this id.');
  }
  return doc;
}

/**
 * @param {*} payload Grammar payload; must pass the shared validator.
 * @returns {Promise<object>} the stored document (id + timestamps added).
 * @throws {HttpError} 400 GRAMMAR_INVALID and the parse-stage 400s.
 */
export async function createGrammar(payload) {
  return store.create(requireValidGrammar(payload));
}

/**
 * @param {string} id Existing document id.
 * @param {*} payload Replacement grammar; same validation as create.
 * @returns {Promise<object>} the updated document (updatedAt bumped).
 * @throws {HttpError} 400 | 404 GRAMMAR_NOT_FOUND.
 */
export async function updateGrammar(id, payload) {
  const doc = await store.update(requireId(id), requireValidGrammar(payload));
  if (doc === null) {
    throw HttpError.notFound('GRAMMAR_NOT_FOUND', 'No saved grammar exists with this id.');
  }
  return doc;
}

/**
 * @param {string} id Document id to delete.
 * @returns {Promise<void>} resolves on success (controller answers 204).
 * @throws {HttpError} 400 INVALID_ID | 404 GRAMMAR_NOT_FOUND.
 */
export async function deleteGrammar(id) {
  const removed = await store.remove(requireId(id));
  if (!removed) {
    throw HttpError.notFound('GRAMMAR_NOT_FOUND', 'No saved grammar exists with this id.');
  }
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
