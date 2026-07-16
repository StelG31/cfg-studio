/**
 * controllers/grammarController.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   HTTP request/response handling for grammar persistence and the built-in
 *   examples. Thin by design: unwrap the request, call the service, choose
 *   the status code. Every error path is an HttpError thrown by the service
 *   and rendered by the central error middleware.
 */

import { asyncHandler } from '../utils/asyncHandler.js';
import * as grammarService from '../services/grammarService.js';

/**
 * Accept both { grammar: {...} } bodies and bare grammar objects.
 *
 * @param {*} body The parsed JSON request body.
 * @returns {*} the grammar payload (wrapped or bare).
 */
function grammarFromBody(body) {
  return body && typeof body === 'object' && 'grammar' in body ? body.grammar : body;
}

/**
 * GET /api/grammars
 * Response: 200 [ {id, name, description, variableCount, terminalCount,
 *           productionCount, createdAt, updatedAt} ] — metadata only
 *           (production lists stay on disk), newest first.
 */
export const listGrammars = asyncHandler(async (req, res) => {
  res.json(await grammarService.listGrammars());
});

/**
 * GET /api/grammars/:id
 * Response: 200 with the full stored document;
 *           400 INVALID_ID / 404 GRAMMAR_NOT_FOUND otherwise.
 */
export const getGrammar = asyncHandler(async (req, res) => {
  res.json(await grammarService.getGrammar(req.params.id));
});

/**
 * POST /api/grammars
 * Body:     a grammar (bare or wrapped); must pass the shared validator —
 *           the server re-checks even though the editor already did.
 * Response: 201 with the stored document (id + timestamps added);
 *           400 GRAMMAR_INVALID with the finding list otherwise.
 */
export const createGrammar = asyncHandler(async (req, res) => {
  const doc = await grammarService.createGrammar(grammarFromBody(req.body));
  res.status(201).json(doc);
});

/**
 * PUT /api/grammars/:id
 * Replaces the document's grammar content; id and createdAt are preserved,
 * updatedAt is bumped. Same validation rules as create.
 * Response: 200 updated document / 400 / 404.
 */
export const updateGrammar = asyncHandler(async (req, res) => {
  res.json(await grammarService.updateGrammar(req.params.id, grammarFromBody(req.body)));
});

/**
 * DELETE /api/grammars/:id
 * Response: 204 (no body — hence .end(), not .json()) / 400 / 404.
 */
export const deleteGrammar = asyncHandler(async (req, res) => {
  await grammarService.deleteGrammar(req.params.id);
  res.status(204).end();
});

/**
 * GET /api/examples
 * Response: 200 with the read-only sample grammars shipped in
 *           data/samples.json (each includes testStrings for the UI chips).
 */
export const listExamples = asyncHandler(async (req, res) => {
  res.json(await grammarService.listExamples());
});
