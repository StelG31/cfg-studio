/**
 * core/grammar.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The grammar data model of CFG Studio and every operation that concerns
 *   the *representation* of a context-free grammar G = (V, Σ, P, S):
 *
 *     - symbol conventions and predicates (what is a valid variable name /
 *       terminal symbol),
 *     - longest-match tokenization of production right-hand sides,
 *     - parsing of user-typed production lines ("S -> ( S ) | ε"),
 *     - formatting grammars back into human-readable text,
 *     - cloning, duplicate-detection keys and JSON (de)serialization.
 *
 *   This module deliberately contains NO validation logic (validator.js),
 *   NO transformations (cnf.js) and NO parsing algorithms (cyk.js) —
 *   single responsibility: the model itself.
 *
 *   It is a pure ES module with zero dependencies and no DOM or Node APIs:
 *   the browser, the Express server and Jest all import THIS file, so the
 *   representation logic exists exactly once in the project.
 *
 * Representation choices (see docs/algorithms.md §1):
 *   - A production's right-hand side is an ARRAY of symbols, never a string,
 *     so "AB" (one variable) and "A","B" (two symbols) can never be confused.
 *   - ε (the empty string) is represented as the empty array [].
 */

/* ------------------------------------------------------------------------ */
/* Symbol conventions                                                        */
/* ------------------------------------------------------------------------ */

/** Canonical symbol used to DISPLAY the empty string. */
export const EPSILON = 'ε';

/** Spellings accepted from the user for the empty string. */
export const EPSILON_ALIASES = new Set(['ε', 'epsilon', 'eps', 'λ', 'lambda']);

/**
 * Variables (non-terminals): an uppercase letter, optionally followed by
 * letters, digits or underscores — e.g. S, A, X1, T_a. Multi-character
 * names are essential: CNF conversion invents fresh variables (S0, X2, ...).
 */
export const VARIABLE_PATTERN = /^[A-Z][A-Za-z0-9_]*$/;

/**
 * Characters that can never be terminals because the production syntax
 * itself uses them: '|' separates alternatives, 'ε'/'λ' denote the empty
 * string. (The arrow '->' is only special as the first occurrence in a
 * production line, so '-' and '>' stay available as terminals.)
 */
const RESERVED_TERMINALS = new Set(['|', 'ε', 'λ']);

export function isValidVariableName(name) {
  return typeof name === 'string' && VARIABLE_PATTERN.test(name);
}

/**
 * Terminals: exactly ONE printable, non-uppercase, non-reserved character
 * (lowercase letters, digits, symbols like ( ) + * a …). Keeping terminals
 * single characters means a CYK input string needs no tokenizer — every
 * character of the input is one terminal.
 */
export function isValidTerminalSymbol(symbol) {
  return (
    typeof symbol === 'string' &&
    symbol.length === 1 &&
    !/[A-Z]/.test(symbol) &&
    !/\s/.test(symbol) &&
    !RESERVED_TERMINALS.has(symbol)
  );
}

/* ------------------------------------------------------------------------ */
/* Constructing grammar objects                                              */
/* ------------------------------------------------------------------------ */

/**
 * Build a normalized grammar object from raw parts. Strings are trimmed and
 * empty entries dropped, but NOTHING is deduplicated or rejected here —
 * reporting duplicate/undefined/invalid symbols with helpful messages is
 * the validator's single responsibility.
 *
 * This is the CANONICAL definition site of the grammar object used across
 * the entire project (editor state, REST payloads, stored documents,
 * algorithm inputs):
 *
 *   { name:        string,      // display name
 *     description: string,      // optional free text
 *     variables:   string[],    // V  — non-terminals, declaration order
 *     terminals:   string[],    // Σ  — single-character terminals
 *     startSymbol: string,      // S  — must be one of `variables` (validator checks)
 *     productions: [ { left: string, right: string[] } ] }
 *                                // P — right = [] means ε; symbols are stored
 *                                // pre-tokenized, so no algorithm ever
 *                                // re-parses text
 *
 * @param {object} [parts] Raw fields in the shape above (all optional).
 * @returns {object} a fresh, normalized grammar object.
 */
export function createGrammar({
  name = 'Untitled grammar',
  description = '',
  variables = [],
  terminals = [],
  startSymbol = '',
  productions = [],
} = {}) {
  return {
    name: String(name).trim() || 'Untitled grammar',
    description: String(description).trim(),
    variables: variables.map((v) => String(v).trim()).filter((v) => v !== ''),
    terminals: terminals.map((t) => String(t).trim()).filter((t) => t !== ''),
    startSymbol: String(startSymbol).trim(),
    productions: productions.map((p) => ({
      left: String(p.left).trim(),
      right: Array.isArray(p.right) ? p.right.map((s) => String(s)) : [],
    })),
  };
}

/** A fresh, blank grammar for the editor's initial state. */
export function createEmptyGrammar(name = 'Untitled grammar') {
  return createGrammar({ name });
}

/**
 * Deep copy (grammars are plain JSON data — no functions, Dates or cycles —
 * so JSON round-tripping is safe and simple).
 *
 * @param {object} grammar Any grammar object.
 * @returns {object} an independent structural copy.
 */
export function cloneGrammar(grammar) {
  return JSON.parse(JSON.stringify(grammar));
}

/** All declared symbols (variables first — they take part in tokenization equally). */
export function allSymbols(grammar) {
  return [...grammar.variables, ...grammar.terminals];
}

/* ------------------------------------------------------------------------ */
/* Production identity (duplicate detection)                                 */
/* ------------------------------------------------------------------------ */

/**
 * A canonical string key for a production, used to detect duplicates.
 * '\u001f' (ASCII unit separator) can never appear in a symbol, so the key
 * is collision-free.
 */
export function productionKey(production) {
  return `${production.left}\u001f${production.right.join('\u001f')}`;
}

export function productionsEqual(a, b) {
  return productionKey(a) === productionKey(b);
}

/* ------------------------------------------------------------------------ */
/* Tokenization: text  ->  array of declared symbols                         */
/* ------------------------------------------------------------------------ */

/**
 * Split the text of a production right-hand side into declared symbols
 * using LONGEST-MATCH (maximal munch) scanning — the same principle a
 * lexer uses. Longest-first ordering guarantees that with variables
 * A and AB declared, "ABc" tokenizes as [AB, c], never [A, B, c].
 *
 * @param {string}   text     Raw right-hand side text (whitespace ignored).
 * @param {string[]} symbols  Every declared symbol (variables + terminals).
 * @returns {{ok: true, tokens: string[]} |
 *           {ok: false, error: {message: string, index: number}}}
 *          On failure, `index` points at the exact offending character so
 *          the editor can show precise feedback.
 */
export function tokenizeRhs(text, symbols) {
  // Sort once per call: longest symbol first so maximal munch wins.
  const byLengthDesc = [...symbols].sort((a, b) => b.length - a.length);
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    const match = byLengthDesc.find((s) => s.length > 0 && text.startsWith(s, i));
    if (!match) {
      return {
        ok: false,
        error: {
          message:
            `Cannot recognise a declared symbol at "${text.slice(i, i + 8)}…" ` +
            `(position ${i + 1}). Declare the symbol first, or check for typos.`,
          index: i,
        },
      };
    }
    tokens.push(match);
    i += match.length;
  }

  return { ok: true, tokens };
}

/* ------------------------------------------------------------------------ */
/* Parsing user-typed production lines                                       */
/* ------------------------------------------------------------------------ */

/**
 * Parse one production line of the form
 *
 *     LHS -> alternative | alternative | ...
 *
 * (both "->" and "→" are accepted). Each alternative is either an epsilon
 * alias (ε / epsilon / eps / λ / lambda → empty right-hand side) or a
 * sequence of declared symbols, tokenized by longest match.
 *
 * The LHS only needs to LOOK like a variable here; whether it is actually
 * declared is the validator's concern. The RHS however must tokenize
 * against declared symbols, because without the declared set the text is
 * meaningless.
 *
 * @returns {{ok: true, productions: {left: string, right: string[]}[]} |
 *           {ok: false, errors: string[]}}
 */
export function parseProductionLine(line, { variables = [], terminals = [] } = {}) {
  const normalized = String(line).replace('→', '->');
  const arrowIndex = normalized.indexOf('->');

  if (arrowIndex === -1) {
    return { ok: false, errors: ['A production needs an arrow: write it as  LHS -> right-hand side.'] };
  }

  const left = normalized.slice(0, arrowIndex).trim();
  const rhsText = normalized.slice(arrowIndex + 2);

  if (left === '') {
    return { ok: false, errors: ['The left-hand side before "->" is empty.'] };
  }
  if (!isValidVariableName(left)) {
    return {
      ok: false,
      errors: [
        `"${left}" is not a valid variable name — variables start with an uppercase letter ` +
          '(e.g. S, A, X1).',
      ],
    };
  }

  const symbols = [...variables, ...terminals];
  const productions = [];
  const errors = [];

  for (const rawAlternative of rhsText.split('|')) {
    const alternative = rawAlternative.trim();

    if (alternative === '') {
      errors.push('An alternative is empty — write ε explicitly for the empty string.');
      continue;
    }
    if (EPSILON_ALIASES.has(alternative)) {
      productions.push({ left, right: [] });
      continue;
    }

    const result = tokenizeRhs(alternative, symbols);
    if (result.ok) {
      productions.push({ left, right: result.tokens });
    } else {
      errors.push(`In "${alternative}": ${result.error.message}`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, productions };
}

/* ------------------------------------------------------------------------ */
/* Formatting grammars back into text                                        */
/* ------------------------------------------------------------------------ */

/**
 * Render one production as text: "S → ( S )"; ε-productions render as "S → ε".
 *
 * @param {{left: string, right: string[]}} production
 * @param {string} [arrow] Arrow glyph (the ASCII "->" is used in tests).
 * @returns {string}
 */
export function productionToString(production, arrow = '→') {
  const rhs = production.right.length === 0 ? EPSILON : production.right.join(' ');
  return `${production.left} ${arrow} ${rhs}`;
}

/**
 * Render a whole grammar as text, grouping alternatives of the same
 * variable on one line (in order of first appearance):
 *
 *     S → ( S ) | S S | ε
 *
 * @param {object} grammar The grammar to format.
 * @param {{arrow?: string, separator?: string}} [options]
 * @returns {string} one line per variable, newline-separated.
 */
export function grammarToText(grammar, { arrow = '→', separator = ' | ' } = {}) {
  const byLeft = new Map();
  for (const production of grammar.productions) {
    if (!byLeft.has(production.left)) byLeft.set(production.left, []);
    byLeft
      .get(production.left)
      .push(production.right.length === 0 ? EPSILON : production.right.join(' '));
  }
  return [...byLeft.entries()]
    .map(([left, alternatives]) => `${left} ${arrow} ${alternatives.join(separator)}`)
    .join('\n');
}

/* ------------------------------------------------------------------------ */
/* JSON (de)serialization — used by export/import and the storage layer      */
/* ------------------------------------------------------------------------ */

export const GRAMMAR_FORMAT = 'cfg-studio-grammar';
export const GRAMMAR_FORMAT_VERSION = 1;

/**
 * Wrap a grammar in a small envelope that identifies the file format —
 * this is exactly what the Export button downloads and what Import expects
 * (import also accepts bare grammar objects, see deserializeGrammar).
 *
 * @param {object} grammar The grammar to export.
 * @returns {string} pretty-printed JSON: {format, version, grammar}.
 */
export function serializeGrammar(grammar) {
  return JSON.stringify(
    { format: GRAMMAR_FORMAT, version: GRAMMAR_FORMAT_VERSION, grammar },
    null,
    2
  );
}

/**
 * Parse and structurally check a grammar from JSON text or a plain object.
 * Accepts both the export envelope ({format, version, grammar}) and a bare
 * grammar object, so users can import hand-written files too.
 *
 * Only STRUCTURE is checked here (types and shapes); the semantic checks
 * (undefined symbols, missing start symbol, ...) belong to the validator.
 *
 * @returns {{ok: true, grammar: object} | {ok: false, error: string}}
 */
export function deserializeGrammar(input) {
  let data = input;

  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      return { ok: false, error: 'The file is not valid JSON.' };
    }
  }
  if (data === null || typeof data !== 'object') {
    return { ok: false, error: 'The file does not contain a JSON object.' };
  }

  // Unwrap the export envelope if present.
  const raw = data.format === GRAMMAR_FORMAT ? data.grammar : data;
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'The file does not contain a grammar object.' };
  }

  const isStringArray = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string');

  if (!isStringArray(raw.variables)) {
    return { ok: false, error: '"variables" must be an array of strings.' };
  }
  if (!isStringArray(raw.terminals)) {
    return { ok: false, error: '"terminals" must be an array of strings.' };
  }
  if (typeof raw.startSymbol !== 'string') {
    return { ok: false, error: '"startSymbol" must be a string.' };
  }
  if (!Array.isArray(raw.productions)) {
    return { ok: false, error: '"productions" must be an array.' };
  }
  for (const [index, production] of raw.productions.entries()) {
    if (
      production === null ||
      typeof production !== 'object' ||
      typeof production.left !== 'string' ||
      !isStringArray(production.right)
    ) {
      return {
        ok: false,
        error:
          `Production #${index + 1} is malformed — expected ` +
          '{ "left": "A", "right": ["b", "C"] } (use "right": [] for ε).',
      };
    }
  }

  return { ok: true, grammar: createGrammar(raw) };
}
