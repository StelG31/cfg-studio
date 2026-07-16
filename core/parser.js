/**
 * core/parser.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Parse-tree reconstruction from a CYK run (see docs/algorithms.md §5).
 *
 *   core/cyk.js stores, for every variable in every table cell, HOW that
 *   variable derived its substring (backpointers: the terminal rule, or a
 *   split length + binary rule). This module walks those backpointers
 *   top-down from (start symbol, whole string) and materialises:
 *
 *     - the derivation tree  (buildParseTree), and
 *     - the leftmost derivation sequence it encodes (leftmostDerivation).
 *
 *   For ambiguous strings the FIRST recorded derivation is used, which is
 *   deterministic (smallest split length first, grammar order second).
 *
 *   Pure ES module — shared verbatim by the browser, the server and Jest.
 */

import { EPSILON } from './grammar.js';

/**
 * Build the derivation tree of an ACCEPTED CYK run.
 *
 * Node shapes:
 *   variable node : { symbol, span: {i, l}, production, children: [...] }
 *   terminal leaf : { symbol, span: {i, l:1}, terminal: true }
 *   ε leaf        : { symbol: 'ε', terminal: true, epsilon: true }
 *
 * Preconditions/assumptions:
 *   - `cykResult` must come from runCyk() unmodified: the walk trusts the
 *     table's backpointers completely (an accepted run guarantees every
 *     visited entry exists; a missing one throws rather than mis-building).
 *   - For ambiguous strings, `derivations[0]` is taken at every entry —
 *     deterministic by construction (CYK records splits smallest-k-first,
 *     grammar order second), so the same input always yields the same tree.
 *
 * @param {object} cykResult The object returned by runCyk().
 * @returns {object|null} the root node, or null when the input was rejected.
 */
export function buildParseTree(cykResult) {
  if (!cykResult || !cykResult.accepted) return null;

  const { table, input, n, startSymbol } = cykResult;

  /* ε: accepted through the single permitted rule S → ε — no table exists. */
  if (n === 0) {
    return {
      symbol: startSymbol,
      span: { i: 0, l: 0 },
      production: { left: startSymbol, right: [] },
      children: [{ symbol: EPSILON, terminal: true, epsilon: true }],
    };
  }

  /** Recursive descent along the recorded backpointers. */
  function build(i, l, variable) {
    const entry = table[l][i].entries.find((e) => e.variable === variable);
    // An accepted run guarantees the walk only visits existing entries;
    // this guard turns a hypothetical inconsistency into a loud error.
    if (!entry || entry.derivations.length === 0) {
      throw new Error(`Inconsistent CYK table: no derivation for ${variable} at (${i}, ${l}).`);
    }

    const derivation = entry.derivations[0];

    if (derivation.type === 'terminal') {
      return {
        symbol: variable,
        span: { i, l: 1 },
        production: derivation.production,
        children: [{ symbol: input[i], span: { i, l: 1 }, terminal: true }],
      };
    }

    const { k, production } = derivation;
    const [leftVariable, rightVariable] = production.right;
    return {
      symbol: variable,
      span: { i, l },
      production,
      children: [build(i, k, leftVariable), build(i + k, l - k, rightVariable)],
    };
  }

  return build(0, n, startSymbol);
}

/* ------------------------------------------------------------------------ */
/* Leftmost derivation                                                       */
/* ------------------------------------------------------------------------ */

/**
 * The leftmost derivation encoded by a parse tree: a list of sentential
 * forms (arrays of symbols) from [S] down to the terminal string.
 * Expanding the leftmost variable at every step is exactly a pre-order
 * traversal of the tree.
 *
 * @returns {string[][]} e.g. [['S0'], ['T_a','X1'], ['a','X1'], ...]
 */
export function leftmostDerivation(tree) {
  if (!tree) return [];

  // The current sentential form as a list of tree NODES (so each variable
  // occurrence remembers which subtree expands it).
  let form = [tree];
  const symbolsOf = (nodes) =>
    nodes.filter((node) => !node.epsilon).map((node) => node.symbol);

  const forms = [symbolsOf(form)];

  for (;;) {
    const index = form.findIndex((node) => !node.terminal);
    if (index === -1) break;
    const node = form[index];
    // Replace the leftmost variable by its children (ε children vanish).
    form = [...form.slice(0, index), ...node.children, ...form.slice(index + 1)];
    forms.push(symbolsOf(form));
  }

  return forms;
}

/* ------------------------------------------------------------------------ */
/* Small tree metrics (view footer + tests)                                  */
/* ------------------------------------------------------------------------ */

/**
 * Total node count. For a CNF derivation of a length-n string this is
 * always exactly 3n − 1 (n terminal leaves + n pre-terminal nodes + n−1
 * binary nodes) — a law the tests assert.
 *
 * @param {object|null} tree
 * @returns {number}
 */
export function countNodes(tree) {
  if (!tree) return 0;
  return 1 + (tree.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

/**
 * Depth in NODES (a single leaf counts as depth 1).
 *
 * @param {object|null} tree
 * @returns {number}
 */
export function treeDepth(tree) {
  if (!tree || !tree.children || tree.children.length === 0) return 1;
  return 1 + Math.max(...tree.children.map(treeDepth));
}

/**
 * The leaves' symbols left-to-right — the tree's "yield". Must spell the
 * input string exactly (ε leaves contribute nothing); the tests use this
 * as the primary structural correctness check.
 *
 * @param {object|null} tree
 * @returns {string[]}
 */
export function frontier(tree) {
  if (!tree) return [];
  if (tree.terminal) return tree.epsilon ? [] : [tree.symbol];
  return (tree.children ?? []).flatMap(frontier);
}
