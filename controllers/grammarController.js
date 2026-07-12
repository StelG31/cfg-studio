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

/** Accept both { grammar: {...} } bodies and bare grammar objects. */
function grammarFromBody(body) {
  return body && typeof body === 'object' && 'grammar' in body ? body.grammar : body;
}

/** GET /api/grammars — metadata list, newest first. */
export const listGrammars = asyncHandler(async (req, res) => {
  res.json(await grammarService.listGrammars());
});

/** GET /api/grammars/:id — one full document. */
export const getGrammar = asyncHandler(async (req, res) => {
  res.json(await grammarService.getGrammar(req.params.id));
});

/** POST /api/grammars — persist a new grammar (validated server-side). */
export const createGrammar = asyncHandler(async (req, res) => {
  const doc = await grammarService.createGrammar(grammarFromBody(req.body));
  res.status(201).json(doc);
});

/** PUT /api/grammars/:id — replace an existing grammar's content. */
export const updateGrammar = asyncHandler(async (req, res) => {
  res.json(await grammarService.updateGrammar(req.params.id, grammarFromBody(req.body)));
});

/** DELETE /api/grammars/:id */
export const deleteGrammar = asyncHandler(async (req, res) => {
  await grammarService.deleteGrammar(req.params.id);
  res.status(204).end();
});

/** GET /api/examples — the built-in sample grammars. */
export const listExamples = asyncHandler(async (req, res) => {
  res.json(await grammarService.listExamples());
});
