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

/** Unwrap { grammar: {...} } bodies; pass anything else through untouched. */
function grammarFromBody(body) {
  return body && typeof body === 'object' && 'grammar' in body ? body.grammar : body;
}

/** POST /api/validate */
export const postValidate = asyncHandler(async (req, res) => {
  res.json(computeService.validate(grammarFromBody(req.body)));
});
