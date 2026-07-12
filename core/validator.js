/**
 * core/validator.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Semantic validation of a grammar object (see docs/algorithms.md §2).
 *
 *   The validator distinguishes:
 *     - ERRORS   → the object is not a well-formed CFG; algorithms must not
 *                  run on it (missing start symbol, undeclared symbols, ...)
 *     - WARNINGS → the grammar is well-formed but contains useless structure
 *                  (unreachable / non-generating variables, unused terminals)
 *                  detected with the two classic fixpoint analyses.
 *
 *   Every finding carries a STABLE machine-readable `code` (tests and the
 *   API rely on codes, never on message wording) plus a student-friendly
 *   message that names the offending symbol or production.
 *
 *   Pure ES module — shared verbatim by the browser, the server and Jest.
 */

import {
  isValidVariableName,
  isValidTerminalSymbol,
  productionKey,
  productionToString,
} from './grammar.js';

/* ------------------------------------------------------------------------ */
/* Finding constructors                                                      */
/* ------------------------------------------------------------------------ */

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

function error(code, message, context = {}) {
  return { code, severity: SEVERITY.ERROR, message, context };
}

function warning(code, message, context = {}) {
  return { code, severity: SEVERITY.WARNING, message, context };
}

/* ------------------------------------------------------------------------ */
/* Fixpoint analyses (also reused by the CNF converter's cleanup stage)      */
/* ------------------------------------------------------------------------ */

/**
 * The set of GENERATING variables: A is generating iff some production
 * A → X1…Xk exists where every Xi is a terminal or itself generating
 * (an ε-production makes its variable generating trivially).
 *
 * Classic bottom-up fixpoint: repeat the scan until a full pass adds
 * nothing new. Terminates because the set only grows and is bounded by |V|.
 *
 * @returns {Set<string>}
 */
export function computeGenerating(grammar) {
  const variables = new Set(grammar.variables);
  const terminals = new Set(grammar.terminals);
  const generating = new Set();

  let changed = true;
  while (changed) {
    changed = false;
    for (const production of grammar.productions) {
      if (generating.has(production.left)) continue;
      if (!variables.has(production.left)) continue; // ignore malformed rows
      const allDerivable = production.right.every(
        (symbol) => terminals.has(symbol) || generating.has(symbol)
      );
      if (allDerivable) {
        generating.add(production.left);
        changed = true;
      }
    }
  }
  return generating;
}

/**
 * The set of variables REACHABLE from the start symbol: breadth-first
 * search that follows every production of an already-reached variable.
 *
 * @returns {Set<string>}
 */
export function computeReachable(grammar) {
  const variables = new Set(grammar.variables);
  const reachable = new Set();
  if (!variables.has(grammar.startSymbol)) return reachable;

  reachable.add(grammar.startSymbol);
  const queue = [grammar.startSymbol];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const production of grammar.productions) {
      if (production.left !== current) continue;
      for (const symbol of production.right) {
        if (variables.has(symbol) && !reachable.has(symbol)) {
          reachable.add(symbol);
          queue.push(symbol);
        }
      }
    }
  }
  return reachable;
}

/* ------------------------------------------------------------------------ */
/* The validator                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Validate a grammar object.
 *
 * @param {object} grammar A grammar as produced by core/grammar.js.
 * @returns {{valid: boolean,
 *            errors:   {code,severity,message,context}[],
 *            warnings: {code,severity,message,context}[]}}
 */
export function validateGrammar(grammar) {
  const errors = [];

  const variables = grammar.variables ?? [];
  const terminals = grammar.terminals ?? [];
  const productions = grammar.productions ?? [];
  const variableSet = new Set(variables);
  const terminalSet = new Set(terminals);

  /* ——— 1. Declarations ——————————————————————————————————————————— */

  if (variables.length === 0) {
    errors.push(
      error('NO_VARIABLES', 'The grammar declares no variables — declare at least a start symbol.')
    );
  }

  for (const variable of variables) {
    if (!isValidVariableName(variable)) {
      errors.push(
        error(
          'INVALID_VARIABLE_NAME',
          `"${variable}" is not a valid variable name — variables start with an uppercase letter, ` +
            'followed by letters, digits or underscores (S, A, X1, …).',
          { symbol: variable }
        )
      );
    }
  }

  for (const terminal of terminals) {
    if (!isValidTerminalSymbol(terminal)) {
      errors.push(
        error(
          'INVALID_TERMINAL_SYMBOL',
          `"${terminal}" is not a valid terminal — terminals are single non-uppercase characters ` +
            '(a, b, 0, (, +, …).',
          { symbol: terminal }
        )
      );
    }
  }

  for (const duplicate of findDuplicates(variables)) {
    errors.push(
      error('DUPLICATE_VARIABLE', `The variable "${duplicate}" is declared more than once.`, {
        symbol: duplicate,
      })
    );
  }

  for (const duplicate of findDuplicates(terminals)) {
    errors.push(
      error('DUPLICATE_TERMINAL', `The terminal "${duplicate}" is declared more than once.`, {
        symbol: duplicate,
      })
    );
  }

  for (const symbol of variables) {
    if (terminalSet.has(symbol)) {
      errors.push(
        error(
          'SYMBOL_CONFLICT',
          `"${symbol}" is declared both as a variable and as a terminal — the two sets must be disjoint.`,
          { symbol }
        )
      );
    }
  }

  /* ——— 2. Start symbol ———————————————————————————————————————————— */

  if (!grammar.startSymbol) {
    errors.push(error('MISSING_START', 'No start symbol is selected.'));
  } else if (!variableSet.has(grammar.startSymbol)) {
    errors.push(
      error(
        'START_NOT_DECLARED',
        `The start symbol "${grammar.startSymbol}" is not among the declared variables.`,
        { symbol: grammar.startSymbol }
      )
    );
  }

  /* ——— 3. Productions ————————————————————————————————————————————— */

  if (productions.length === 0) {
    errors.push(error('NO_PRODUCTIONS', 'The grammar has no productions — add at least one.'));
  }

  productions.forEach((production, index) => {
    const shown = productionToString(production);

    if (!variableSet.has(production.left)) {
      errors.push(
        error(
          'INVALID_PRODUCTION_LHS',
          `Production ${shown}: the left-hand side "${production.left}" is not a declared variable.`,
          { production: shown, index, symbol: production.left }
        )
      );
    }

    for (const symbol of production.right) {
      if (!variableSet.has(symbol) && !terminalSet.has(symbol)) {
        errors.push(
          error(
            'UNDEFINED_SYMBOL',
            `Production ${shown} uses "${symbol}", which is neither a declared variable nor a terminal.`,
            { production: shown, index, symbol }
          )
        );
      }
    }
  });

  const seenKeys = new Set();
  productions.forEach((production, index) => {
    const key = productionKey(production);
    if (seenKeys.has(key)) {
      const shown = productionToString(production);
      errors.push(
        error('DUPLICATE_PRODUCTION', `The production ${shown} appears more than once.`, {
          production: shown,
          index,
        })
      );
    }
    seenKeys.add(key);
  });

  /* ——— 4. Warnings (useless structure) ———————————————————————————— */
  /* Only when the grammar is structurally sound: fixpoint analyses over
     a broken grammar would produce misleading noise.                     */

  const warnings = [];
  if (errors.length === 0) {
    const generating = computeGenerating(grammar);
    const reachable = computeReachable(grammar);

    if (!generating.has(grammar.startSymbol)) {
      warnings.push(
        warning(
          'EMPTY_LANGUAGE',
          `The start symbol "${grammar.startSymbol}" cannot derive any string of terminals — ` +
            'the language of this grammar is empty.',
          { symbol: grammar.startSymbol }
        )
      );
    }

    for (const variable of variables) {
      if (variable !== grammar.startSymbol && !generating.has(variable)) {
        warnings.push(
          warning(
            'NONGENERATING_VARIABLE',
            `Variable "${variable}" can never derive a string of terminals — productions using it are dead ends.`,
            { symbol: variable }
          )
        );
      }
    }

    for (const variable of variables) {
      if (!reachable.has(variable)) {
        warnings.push(
          warning(
            'UNREACHABLE_VARIABLE',
            `Variable "${variable}" can never be reached from the start symbol — it does not affect the language.`,
            { symbol: variable }
          )
        );
      }
    }

    const usedTerminals = new Set(
      productions.flatMap((production) => production.right.filter((s) => terminalSet.has(s)))
    );
    for (const terminal of terminals) {
      if (!usedTerminals.has(terminal)) {
        warnings.push(
          warning(
            'UNUSED_TERMINAL',
            `The terminal "${terminal}" does not appear in any production.`,
            { symbol: terminal }
          )
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** Every value that appears more than once (each reported a single time). */
function findDuplicates(list) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of list) {
    if (seen.has(item)) duplicates.add(item);
    seen.add(item);
  }
  return [...duplicates];
}
