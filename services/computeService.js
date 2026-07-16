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
import { convertToCnf } from '../core/cnf.js';
import { runCyk } from '../core/cyk.js';
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
 *
 * Structural checking only (shapes/types via deserializeGrammar) plus the
 * size guard — SEMANTIC validity is a separate, later concern
 * (parseValidGrammar), because /api/validate must accept semantically
 * broken grammars in order to report their findings.
 *
 * @param {*} payload The request body (or its `grammar` field).
 * @returns {object} a normalized grammar object.
 * @throws {HttpError} 400 MISSING_GRAMMAR | INVALID_GRAMMAR_FORMAT |
 *                     GRAMMAR_TOO_LARGE.
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

/**
 * POST /api/validate — run the shared validator over the payload.
 *
 * @param {*} payload Grammar payload (bare or enveloped).
 * @returns {{valid: boolean, errors: object[], warnings: object[]}}
 * @throws {HttpError} 400 for structurally malformed payloads only —
 *                     semantic problems are the RESPONSE, not an error.
 */
export function validate(payload) {
  const grammar = parseGrammarPayload(payload);
  return validateGrammar(grammar);
}

/**
 * Parse + require a VALID grammar, or throw 400 with the finding list.
 * Used by the algorithm endpoints (CNF, CYK), which must never run on
 * semantically broken input.
 *
 * @param {*} payload Grammar payload (bare or enveloped).
 * @returns {object} a normalized, validator-clean grammar.
 * @throws {HttpError} 400 GRAMMAR_INVALID with details.errors = findings.
 */
function parseValidGrammar(payload) {
  const grammar = parseGrammarPayload(payload);
  const result = validateGrammar(grammar);
  if (!result.valid) {
    throw HttpError.badRequest(
      'GRAMMAR_INVALID',
      'The grammar must be valid before running this algorithm.',
      { errors: result.errors }
    );
  }
  return grammar;
}

/**
 * POST /api/cnf — full CNF conversion with the step-by-step trace.
 *
 * @param {*} payload Grammar payload (bare or enveloped); must be valid.
 * @returns {object} convertToCnf's result (original, steps, result, ...).
 * @throws {HttpError} 400 on malformed/oversized/invalid grammars.
 */
export function cnf(payload) {
  return convertToCnf(parseValidGrammar(payload));
}

/**
 * POST /api/cyk — run CYK over {grammar, input}.
 * The grammar must be valid AND in CNF; the input a string over Σ.
 * CykError conditions (wrong form, bad character, too long) become 400s
 * with their stable codes preserved — the client can show the core's
 * message verbatim because it was written for end users.
 *
 * @param {*} body Expected shape: { grammar, input }.
 * @returns {object} runCyk's result (accepted, table, steps, ...).
 * @throws {HttpError} 400 MISSING_BODY | MISSING_INPUT | GRAMMAR_INVALID |
 *                     <any CykError code>.
 */
export function cyk(body) {
  if (body === undefined || body === null || typeof body !== 'object') {
    throw HttpError.badRequest('MISSING_BODY', 'Expected a JSON body { grammar, input }.');
  }
  const grammar = parseValidGrammar(body.grammar);
  if (typeof body.input !== 'string') {
    throw HttpError.badRequest('MISSING_INPUT', 'The request must include "input" as a string.');
  }
  try {
    return runCyk(grammar, body.input);
  } catch (err) {
    if (err.name === 'CykError') {
      throw HttpError.badRequest(err.code, err.message);
    }
    throw err;
  }
}
