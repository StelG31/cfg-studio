/**
 * core/cyk.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The Cocke–Younger–Kasami membership algorithm over a grammar in
 *   Chomsky Normal Form (see docs/algorithms.md §4).
 *
 *   Besides the classic dynamic-programming table, runCyk records:
 *     - BACKPOINTERS on every table entry (every way a variable can derive
 *       its substring) — consumed by core/parser.js to build parse trees,
 *     - a granular STEP TRACE (begin / init-cell / combine / cell-done /
 *       verdict) with human-readable explanations — consumed by the UI to
 *       animate the table fill cell by cell.
 *
 *   Table addressing convention used everywhere in the project:
 *     cell (i, l) = the substring starting at 0-based position i with
 *     length l. The user-facing explanations use 1-based positions.
 *
 *   Pure ES module — shared verbatim by the browser, the server and Jest.
 */

import { isCnf } from './cnf.js';
import { productionToString } from './grammar.js';

/** Hard cap on the input length: keeps the animated table readable and the
 *  O(n³) trace bounded. 30 is far beyond any classroom example. */
export const MAX_INPUT_LENGTH = 30;

/** An Error subtype carrying a stable machine-readable code. */
class CykError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CykError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------------ */
/* Precondition checks                                                       */
/* ------------------------------------------------------------------------ */

function assertRunnable(grammar, input) {
  if (!isCnf(grammar)) {
    throw new CykError(
      'GRAMMAR_NOT_CNF',
      'CYK requires a grammar in Chomsky Normal Form — convert the grammar first.'
    );
  }
  if (typeof input !== 'string') {
    throw new CykError('INVALID_INPUT', 'The input must be a string.');
  }
  if (input.length > MAX_INPUT_LENGTH) {
    throw new CykError(
      'INPUT_TOO_LONG',
      `The input has ${input.length} characters — the simulator supports at most ` +
        `${MAX_INPUT_LENGTH} (CYK is O(n³), and the table must stay readable).`
    );
  }
  const terminals = new Set(grammar.terminals);
  for (let position = 0; position < input.length; position += 1) {
    if (!terminals.has(input[position])) {
      throw new CykError(
        'INVALID_INPUT_CHAR',
        `Character "${input[position]}" at position ${position + 1} is not in the grammar's ` +
          `alphabet Σ = { ${grammar.terminals.join(', ')} }.`
      );
    }
  }
}

/* ------------------------------------------------------------------------ */
/* The algorithm                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Run CYK.
 *
 * @param {object} grammar A grammar in CNF (throws GRAMMAR_NOT_CNF otherwise).
 * @param {string} input   The string to test (characters must all be in Σ).
 * @returns {{
 *   accepted: boolean, input: string, n: number, startSymbol: string,
 *   table: Array<Array<{entries: {variable, derivations}[]}>>,
 *            // table[l][i], l = 1..n, i = 0..n-l
 *   steps: object[]  // the animation trace, ending with a 'verdict' step
 * }}
 * @throws {CykError} GRAMMAR_NOT_CNF | INVALID_INPUT | INPUT_TOO_LONG |
 *                    INVALID_INPUT_CHAR
 */
export function runCyk(grammar, input) {
  assertRunnable(grammar, input);

  const n = input.length;
  const start = grammar.startSymbol;
  const steps = [];

  /* ——— Special case: the empty string ————————————————————————— */
  if (n === 0) {
    const hasEpsilonRule = grammar.productions.some(
      (p) => p.left === start && p.right.length === 0
    );
    steps.push({
      type: 'begin',
      explanation:
        'The input is the empty string ε. In CNF the only possible ε-derivation is the single ' +
        `permitted rule ${start} → ε, so no table is needed.`,
    });
    steps.push({
      type: 'verdict',
      accepted: hasEpsilonRule,
      explanation: hasEpsilonRule
        ? `The rule ${start} → ε exists, so ε ∈ L(G): ACCEPTED.`
        : `There is no rule ${start} → ε, so ε ∉ L(G): REJECTED.`,
    });
    return { accepted: hasEpsilonRule, input, n, startSymbol: start, table: [], steps };
  }

  /* ——— Pre-index the grammar ————————————————————————————————— */

  /** terminal a → every rule A → a. */
  const terminalRules = new Map();
  /** "B␟C" → every rule A → B C. */
  const binaryRules = new Map();

  for (const production of grammar.productions) {
    if (production.right.length === 1) {
      const terminal = production.right[0];
      if (!terminalRules.has(terminal)) terminalRules.set(terminal, []);
      terminalRules.get(terminal).push(production);
    } else if (production.right.length === 2) {
      const key = production.right.join('\u001f');
      if (!binaryRules.has(key)) binaryRules.set(key, []);
      binaryRules.get(key).push(production);
    }
  }

  /* ——— Build the empty table ————————————————————————————————— */
  // table[l][i]: substring starting at i (0-based) of length l (1-based).
  const table = [];
  for (let l = 1; l <= n; l += 1) {
    table[l] = [];
    for (let i = 0; i <= n - l; i += 1) {
      table[l][i] = { entries: [] };
    }
  }

  /** The entry for `variable` in cell (i, l), created on first use. */
  const entryFor = (i, l, variable) => {
    const cell = table[l][i];
    let entry = cell.entries.find((e) => e.variable === variable);
    if (!entry) {
      entry = { variable, derivations: [] };
      cell.entries.push(entry);
    }
    return entry;
  };

  const cellVariables = (i, l) => table[l][i].entries.map((e) => e.variable);

  steps.push({
    type: 'begin',
    explanation:
      `CYK fills a triangular table for w = "${input}" (n = ${n}). Cell (i, l) collects every ` +
      'variable that derives the substring starting at position i with length l — bottom row ' +
      'first, then longer substrings built from shorter ones.',
  });

  /* ——— Base row: substrings of length 1 ————————————————————— */
  for (let i = 0; i < n; i += 1) {
    const terminal = input[i];
    const rules = terminalRules.get(terminal) ?? [];
    for (const production of rules) {
      entryFor(i, 1, production.left).derivations.push({ type: 'terminal', production });
    }
    const variables = cellVariables(i, 1);
    steps.push({
      type: 'init-cell',
      i,
      l: 1,
      terminal,
      matches: rules.map((p) => ({ variable: p.left, production: p })),
      explanation:
        `w[${i + 1}] = "${terminal}". ` +
        (rules.length > 0
          ? `Rules producing "${terminal}": ${rules.map(productionToString).join(', ')} — ` +
            `so cell (${i + 1}, 1) = { ${variables.join(', ')} }.`
          : `No rule produces "${terminal}", so cell (${i + 1}, 1) stays empty.`),
    });
  }

  /* ——— Induction: lengths 2..n ————————————————————————————— */
  for (let l = 2; l <= n; l += 1) {
    for (let i = 0; i <= n - l; i += 1) {
      for (let k = 1; k < l; k += 1) {
        const leftVars = cellVariables(i, k);
        const rightVars = cellVariables(i + k, l - k);
        const found = [];

        for (const leftVariable of leftVars) {
          for (const rightVariable of rightVars) {
            const rules = binaryRules.get(`${leftVariable}\u001f${rightVariable}`) ?? [];
            for (const production of rules) {
              entryFor(i, l, production.left).derivations.push({
                type: 'split',
                k,
                production,
              });
              found.push({ variable: production.left, production, k });
            }
          }
        }

        const leftLabel = `(${i + 1}, ${k})`;
        const rightLabel = `(${i + k + 1}, ${l - k})`;
        steps.push({
          type: 'combine',
          i,
          l,
          k,
          leftCell: { i, l: k },
          rightCell: { i: i + k, l: l - k },
          found,
          explanation:
            `Split "${input.slice(i, i + l)}" as "${input.slice(i, i + k)}" | ` +
            `"${input.slice(i + k, i + l)}": left cell ${leftLabel} = ` +
            `{ ${leftVars.join(', ') || '∅'} }, right cell ${rightLabel} = ` +
            `{ ${rightVars.join(', ') || '∅'} }. ` +
            (found.length > 0
              ? `Matching rules: ${[...new Set(found.map((f) => productionToString(f.production)))].join(
                  ', '
                )} → add { ${[...new Set(found.map((f) => f.variable))].join(', ')} }.`
              : 'No rule A → B C matches this pair of sets.'),
        });
      }

      const variables = cellVariables(i, l);
      steps.push({
        type: 'cell-done',
        i,
        l,
        vars: variables,
        explanation:
          `Cell (${i + 1}, ${l}) is complete: ` +
          (variables.length > 0
            ? `{ ${variables.join(', ')} } derive${variables.length === 1 ? 's' : ''} ` +
              `"${input.slice(i, i + l)}".`
            : `no variable derives "${input.slice(i, i + l)}".`),
      });
    }
  }

  /* ——— Verdict ——————————————————————————————————————————————— */
  const accepted = cellVariables(0, n).includes(start);
  steps.push({
    type: 'verdict',
    accepted,
    explanation: accepted
      ? `The start symbol ${start} is in the top cell (1, ${n}), so it derives the whole ` +
        `string: "${input}" ∈ L(G) — ACCEPTED.`
      : `The top cell (1, ${n}) contains { ${cellVariables(0, n).join(', ') || '∅'} } but not ` +
        `the start symbol ${start}: "${input}" ∉ L(G) — REJECTED.`,
  });

  return { accepted, input, n, startSymbol: start, table, steps };
}
