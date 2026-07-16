/**
 * controllers/computeController.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   HTTP request/response handling for the computation endpoints
 *   (/api/validate, and later /api/cnf, /api/cyk). Controllers stay thin:
 *   unwrap the body, call the service, send JSON. All error translation
 *   happens in the service layer and the central error middleware.
 *
 *   Bodies may send the grammar either at the top level or wrapped as
 *   { "grammar": {...} } — both are accepted for convenience.
 */

import { asyncHandler } from '../utils/asyncHandler.js';
import * as computeService from '../services/computeService.js';

/**
 * Unwrap { grammar: {...} } bodies; pass anything else through untouched.
 *
 * @param {*} body The parsed JSON request body.
 * @returns {*} the grammar payload (wrapped or bare).
 */
function grammarFromBody(body) {
  return body && typeof body === 'object' && 'grammar' in body ? body.grammar : body;
}

/**
 * POST /api/validate
 * Body:     a grammar object, bare or wrapped as { grammar }.
 * Response: 200 { valid, errors[], warnings[] } — the shared validator's
 *           findings verbatim; malformed payloads become 400s in the service.
 */
export const postValidate = asyncHandler(async (req, res) => {
  res.json(computeService.validate(grammarFromBody(req.body)));
});

/**
 * POST /api/cnf
 * Body:     a VALID grammar (bare or wrapped).
 * Response: 200 with the full conversion object
 *           { original, alreadyCnf, steps[], result, emptyLanguage };
 *           400 GRAMMAR_INVALID (with the finding list) otherwise.
 */
export const postCnf = asyncHandler(async (req, res) => {
  res.json(computeService.cnf(grammarFromBody(req.body)));
});

/**
 * POST /api/cyk
 * Body:     { grammar: <valid CNF grammar>, input: string }.
 * Response: 200 with runCyk's result { accepted, n, table, steps, ... };
 *           400 with a stable code (GRAMMAR_NOT_CNF, INVALID_INPUT_CHAR,
 *           INPUT_TOO_LONG, ...) on any precondition failure.
 */
export const postCyk = asyncHandler(async (req, res) => {
  res.json(computeService.cyk(req.body));
});
