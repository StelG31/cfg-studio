/**
 * core/earley-tree.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Parse-tree reconstruction from an Earley chart (see docs/algorithms.md §7).
 *
 *   core/earley.js records on every item HOW its dot reached its position:
 *   a scan that read a terminal, or a completion that consumed a variable.
 *   Walking those backpointers from the accepting item yields a derivation
 *   tree of the USER'S OWN grammar — n-ary nodes labelled with the very
 *   productions the user wrote, never with the binary rules of a converted
 *   grammar.
 *
 *   The node shape is deliberately IDENTICAL to core/parser.js, so frontier,
 *   countNodes, treeDepth, leftmostDerivation and the SVG renderer in
 *   public/js/tree.js accept both kinds of tree unchanged.
 *
 *   Pure ES module — shared verbatim by the browser, the server and Jest.
 */

import { EPSILON } from './grammar.js';

/**
 * Build the derivation tree of an ACCEPTED Earley run.
 *
 * Node shapes (the same contract core/parser.js documents):
 *   variable node : { symbol, span: {i, l}, production, children: [...] }
 *   terminal leaf : { symbol, span: {i, l:1}, terminal: true }
 *   ε leaf        : { symbol: 'ε', terminal: true, epsilon: true }
 *
 * Preconditions/assumptions:
 *   - `earleyResult` must come from runEarley() unmodified: the walk trusts
 *     the chart's backpointers completely (an accepted run guarantees every
 *     visited item exists; a missing one throws rather than mis-building).
 *   - derivations[0] is taken at every step. That is the derivation which
 *     CREATED the item, so both pointers it carries refer to items that
 *     already existed at that moment — the walk therefore descends strictly
 *     along the chart's creation order and cannot cycle, not even on unit
 *     cycles or zero-width nullable children. No visited set is needed, and
 *     the same input always yields the same tree.
 *
 * @param {object} earleyResult The object returned by runEarley().
 * @returns {object|null} the root node, or null when the input was rejected.
 */
export function buildEarleyTree(earleyResult) {
  if (!earleyResult || !earleyResult.accepted) return null;

  const { chart, input, n, startSymbol } = earleyResult;

  const rootIndex = chart[n].items.findIndex(
    (item) =>
      item.production.left === startSymbol &&
      item.origin === 0 &&
      item.dot === item.production.right.length
  );
  // An accepted run guarantees this item exists; the guard turns a
  // hypothetical inconsistency into a loud error rather than a wrong tree.
  if (rootIndex === -1) {
    throw new Error(
      `Inconsistent Earley chart: no completed ${startSymbol}-item with origin 0 in column ${n}.`
    );
  }

  /**
   * The subtree rooted at the COMPLETED item chart[column].items[index].
   *
   * The children are not stored on the item — they are recovered by walking
   * the derivation chain backwards from the final dot to dot 0, one symbol
   * of the right-hand side per step, prepending as we go.
   */
  function build(column, index) {
    const item = chart[column].items[index];
    const children = [];

    let cursor = { column, index };
    for (;;) {
      const current = chart[cursor.column].items[cursor.index];
      if (current.dot === 0) break;

      const derivation = current.derivations[0];
      if (!derivation) {
        throw new Error(
          `Inconsistent Earley chart: ${itemLabel(current)} in column ${cursor.column} has an ` +
            'advanced dot but no derivation.'
        );
      }

      if (derivation.type === 'scan') {
        // The terminal was read between the predecessor's column and this
        // one, so it is the input character at the predecessor's column.
        const at = derivation.back.column;
        children.unshift({ symbol: input[at], span: { i: at, l: 1 }, terminal: true });
      } else {
        children.unshift(build(derivation.child.column, derivation.child.index));
      }

      cursor = derivation.back;
    }

    // An ε-production collects no children above; give it the ε leaf, the
    // same marker core/parser.js uses so frontier() skips it.
    if (item.production.right.length === 0) {
      children.push({ symbol: EPSILON, terminal: true, epsilon: true });
    }

    return {
      symbol: item.production.left,
      span: { i: item.origin, l: column - item.origin },
      production: item.production,
      children,
    };
  }

  return build(n, rootIndex);
}

/** A production label for error messages (this module renders no trace). */
function itemLabel(item) {
  return `${item.production.left} → ${item.production.right.join(' ') || 'ε'}`;
}
