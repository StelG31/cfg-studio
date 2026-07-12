/**
 * services/computeService.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Server-side gateway to the shared algorithm core (core/). The service
 *   adds exactly what the pure algorithms must not know about:
 *
 *     - payload parsing and structural checks (deserializeGrammar),
 *     - resource guards (size limits) so a hostile payload cannot make the
 *       server compute forever,
 *     - translation of problems into HttpError responses.
 *
 *   The algorithms themselves run UNCHANGED from core/ — the same files the
 *   browser imports. Endpoints for CNF conversion and CYK are added in their
 *   respective implementation steps.
 */

import { deserializeGrammar } from '../core/grammar.js';
import { validateGrammar } from '../core/validator.js';
import { HttpError } from '../utils/httpError.js';

/** Hard limits — far above anything a classroom grammar needs. */
export const LIMITS = {
  variables: 100,
  terminals: 100,
  productions: 200,
  rhsLength: 50,
};

/**
 * Parse a request payload into a grammar object or throw a 400.
 * Accepts either a bare grammar or the {format, version, grammar} envelope.
 */
export function parseGrammarPayload(payload) {
  if (payload === undefined || payload === null) {
    throw HttpError.badRequest('MISSING_GRAMMAR', 'The request body must contain a grammar.');
  }

  const result = deserializeGrammar(payload);
  if (!result.ok) {
    throw HttpError.badRequest('INVALID_GRAMMAR_FORMAT', result.error);
  }

  const grammar = result.grammar;
  if (
    grammar.variables.length > LIMITS.variables ||
    grammar.terminals.length > LIMITS.terminals ||
    grammar.productions.length > LIMITS.productions ||
    grammar.productions.some((p) => p.right.length > LIMITS.rhsLength)
  ) {
    throw HttpError.badRequest(
      'GRAMMAR_TOO_LARGE',
      `The grammar exceeds the supported size (max ${LIMITS.variables} variables, ` +
        `${LIMITS.terminals} terminals, ${LIMITS.productions} productions, ` +
        `right-hand sides of ${LIMITS.rhsLength} symbols).`
    );
  }

  return grammar;
}

/** POST /api/validate — run the shared validator over the payload. */
export function validate(payload) {
  const grammar = parseGrammarPayload(payload);
  return validateGrammar(grammar);
}
