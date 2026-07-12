/**
 * tests/helpers.js
 * ---------------------------------------------------------------------------
 * Test-only utilities.
 *
 * languageUpTo(grammar, maxLen) enumerates every string of L(G) with length
 * ≤ maxLen by breadth-first exploration of leftmost derivations. It is the
 * strongest practical equivalence check for the CNF tests: converting a
 * grammar must not change its language, so the enumerated sets before and
 * after conversion must be identical.
 *
 * Pruning that guarantees termination on the small test grammars:
 *   - sentential forms containing more than maxLen terminals are dead ends
 *     (terminals never disappear),
 *   - forms longer than 3·maxLen + 4 symbols are abandoned (generous bound
 *     for the shapes used in the fixtures),
 *   - a visited-set both deduplicates and caps the exploration.
 */

export function languageUpTo(grammar, maxLen, cap = 200000) {
  const variables = new Set(grammar.variables);
  const results = new Set();
  const visited = new Set();
  const queue = [[grammar.startSymbol]];

  while (queue.length > 0 && visited.size < cap) {
    const form = queue.shift();
    const key = form.join('');
    if (visited.has(key)) continue;
    visited.add(key);

    if (form.length > 3 * maxLen + 4) continue;
    const terminalCount = form.reduce((n, s) => n + (variables.has(s) ? 0 : 1), 0);
    if (terminalCount > maxLen) continue;

    const variableIndex = form.findIndex((s) => variables.has(s));
    if (variableIndex === -1) {
      results.add(form.join(''));
      continue;
    }

    for (const production of grammar.productions) {
      if (production.left !== form[variableIndex]) continue;
      queue.push([
        ...form.slice(0, variableIndex),
        ...production.right,
        ...form.slice(variableIndex + 1),
      ]);
    }
  }

  return results;
}
