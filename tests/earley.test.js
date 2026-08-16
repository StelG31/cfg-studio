/**
 * tests/earley.test.js
 * ---------------------------------------------------------------------------
 * Covers:
 *   - membership on the sample grammars, run on the ORIGINAL grammar with no
 *     CNF conversion anywhere in sight,
 *   - ε-productions: the Aycock–Horspool case, with the targeted regressions
 *     that a naive completer silently fails,
 *   - the triple cross-check — brute-force enumeration, CYK over the CNF
 *     conversion, and structural validity of the reconstructed tree,
 *   - left recursion (the arithmetic sample) terminating at all,
 *   - chart/trace anatomy and every typed error code.
 */

import { runEarley, itemToString, MAX_INPUT_LENGTH } from '../core/earley.js';
import { buildEarleyTree } from '../core/earley-tree.js';
import { runCyk } from '../core/cyk.js';
import { convertToCnf } from '../core/cnf.js';
import { createGrammar, productionKey } from '../core/grammar.js';
import { frontier, countNodes, treeDepth, leftmostDerivation } from '../core/parser.js';
import { languageUpTo } from './helpers.js';
import {
  anbn,
  balancedParentheses,
  arithmetic,
  palindromes,
  equalAsBs,
} from './fixtures/grammars.js';

/** Every string over `alphabet` of length 0..maxLen, shortest first. */
function allStringsOver(alphabet, maxLen) {
  const all = [''];
  let level = [''];
  for (let length = 1; length <= maxLen; length += 1) {
    level = level.flatMap((prefix) => alphabet.map((symbol) => prefix + symbol));
    all.push(...level);
  }
  return all;
}

/** Jest label for a string case: the empty string shows as ε. */
const labelled = (strings) => strings.map((s) => [s === '' ? 'ε' : s, s]);

/* ------------------------------------------------------------------------ */
/* Grammars that exist only to stress ε-handling                             */
/* ------------------------------------------------------------------------ */

/**
 * S → A B, B → A c, A → ε.
 *
 * THE regression. B → • A c enters column 0 only after A's ε-completion has
 * already finished scanning the column, and re-predicting A yields nothing
 * but a duplicate — so without the repair inside predict() the dot never
 * moves over A, "c" is never scanned, and S ⇒ A B ⇒ B ⇒ A c ⇒ c is lost.
 */
function lateNullable() {
  return createGrammar({
    name: 'Late nullable',
    variables: ['S', 'A', 'B'],
    terminals: ['c'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['A', 'B'] },
      { left: 'B', right: ['A', 'c'] },
      { left: 'A', right: [] },
    ],
  });
}

/** S → A A with A nullable: the second A is discovered while the completer
 *  for the first one is still scanning the column. */
function doubleNullable() {
  return createGrammar({
    name: 'Double nullable',
    variables: ['S', 'A'],
    terminals: ['a'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['A', 'A'] },
      { left: 'A', right: ['a'] },
      { left: 'A', right: [] },
    ],
  });
}

/** S → A B C with every one of A, B, C nullable — a chain of ε-completions
 *  that all live in the same column. */
function nullableChain() {
  return createGrammar({
    name: 'Nullable chain',
    variables: ['S', 'A', 'B', 'C'],
    terminals: ['x'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['A', 'B', 'C'] },
      { left: 'A', right: [] },
      { left: 'B', right: [] },
      { left: 'C', right: [] },
      { left: 'C', right: ['x'] },
    ],
  });
}

/** A nullable variable in the MIDDLE of a right-hand side. */
function nullableInMiddle() {
  return createGrammar({
    name: 'Nullable in the middle',
    variables: ['S', 'A'],
    terminals: ['a', 'b'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['a', 'A', 'b'] },
      { left: 'A', right: [] },
    ],
  });
}

/** The whole grammar is one ε-rule. */
function onlyEpsilon() {
  return createGrammar({
    name: 'Only ε',
    variables: ['S'],
    terminals: ['a'],
    startSymbol: 'S',
    productions: [{ left: 'S', right: [] }],
  });
}

/* ------------------------------------------------------------------------ */
/* Membership on the sample grammars (no CNF conversion)                     */
/* ------------------------------------------------------------------------ */

const membershipCases = [
  {
    name: 'a^n b^n',
    grammar: anbn(),
    accept: ['', 'ab', 'aabb', 'aaabbb'],
    reject: ['a', 'ba', 'abab', 'aab'],
  },
  {
    name: 'balanced parentheses',
    grammar: balancedParentheses(),
    accept: ['', '()', '(())', '()()', '(()())'],
    reject: ['(', '())', ')(', '(()'],
  },
  {
    name: 'palindromes over {a,b}',
    grammar: palindromes(),
    accept: ['', 'a', 'aba', 'abba', 'babab'],
    reject: ['ab', 'aab', 'abab'],
  },
  {
    name: 'arithmetic expressions',
    grammar: arithmetic(),
    accept: ['a', 'a+a', 'a+a*a', '(a+a)*a'],
    reject: ['a+', '*a', '(a', 'a++a'],
  },
  {
    name: "equal numbers of a's and b's",
    grammar: equalAsBs(),
    accept: ['', 'ab', 'ba', 'abba', 'baab', 'aabb'],
    reject: ['a', 'b', 'aab', 'abb'],
  },
];

describe('membership on the sample grammars (no CNF conversion)', () => {
  for (const { name, grammar, accept, reject } of membershipCases) {
    describe(name, () => {
      test.each(labelled(accept))('accepts %s', (_label, s) => {
        expect(runEarley(grammar, s).accepted).toBe(true);
      });

      test.each(labelled(reject))('rejects %s', (_label, s) => {
        expect(runEarley(grammar, s).accepted).toBe(false);
      });
    });
  }
});

/* ------------------------------------------------------------------------ */
/* ε-productions — the Aycock–Horspool case                                  */
/* ------------------------------------------------------------------------ */

describe('ε-productions (the Aycock–Horspool case)', () => {
  test('a nullable predicted AFTER its own completion still advances the dot', () => {
    // The single most important assertion in this file: this is the exact
    // string a live completer scan alone loses.
    const result = runEarley(lateNullable(), 'c');
    expect(result.accepted).toBe(true);
    expect(frontier(buildEarleyTree(result)).join('')).toBe('c');
  });

  test('S → A A with A → ε accepts ε', () => {
    expect(runEarley(doubleNullable(), '').accepted).toBe(true);
  });

  test.each(labelled(['', 'a', 'aa']))('S → A A with A → a | ε accepts %s', (_label, s) => {
    const result = runEarley(doubleNullable(), s);
    expect(result.accepted).toBe(true);
    expect(frontier(buildEarleyTree(result)).join('')).toBe(s);
  });

  test.each(labelled(['aaa', 'aaaa']))('S → A A with A → a | ε rejects %s', (_label, s) => {
    expect(runEarley(doubleNullable(), s).accepted).toBe(false);
  });

  test.each(labelled(['', 'x']))('S → A B C with all three nullable accepts %s', (_label, s) => {
    const result = runEarley(nullableChain(), s);
    expect(result.accepted).toBe(true);
    expect(frontier(buildEarleyTree(result)).join('')).toBe(s);
  });

  test('a nullable in the middle of a right-hand side is skipped', () => {
    const result = runEarley(nullableInMiddle(), 'ab');
    expect(result.accepted).toBe(true);
    expect(frontier(buildEarleyTree(result)).join('')).toBe('ab');
  });

  test('S → ε accepts ε and rejects a', () => {
    expect(runEarley(onlyEpsilon(), '').accepted).toBe(true);
    expect(runEarley(onlyEpsilon(), 'a').accepted).toBe(false);
  });

  test('the ε tree carries an ε leaf that contributes nothing to the frontier', () => {
    const tree = buildEarleyTree(runEarley(onlyEpsilon(), ''));
    expect(tree.symbol).toBe('S');
    expect(tree.span).toEqual({ i: 0, l: 0 });
    expect(tree.children).toEqual([{ symbol: 'ε', terminal: true, epsilon: true }]);
    expect(frontier(tree)).toEqual([]);
  });

  test('ε needs no special case: the chart is one column and it accepts', () => {
    const result = runEarley(anbn(), '');
    expect(result.chart).toHaveLength(1);
    expect(result.accepted).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* Cross-check 1 — agreement with brute-force enumeration                    */
/* ------------------------------------------------------------------------ */

describe('agreement with brute-force enumeration', () => {
  // The arithmetic grammar is deliberately absent: languageUpTo's
  // 3*maxLen+4 sentential-form bound is not reliable for it, which is why
  // cnf.test.js leaves it out of its own enumeration test too.
  const bruteForceCases = [
    ['a^n b^n', anbn(), ['a', 'b'], 5],
    ['palindromes', palindromes(), ['a', 'b'], 5],
    ["equal numbers of a's and b's", equalAsBs(), ['a', 'b'], 5],
    ['balanced parentheses', balancedParentheses(), ['(', ')'], 5],
    ['S → A A, A → a | ε', doubleNullable(), ['a'], 5],
    ['S → A B, B → A c, A → ε', lateNullable(), ['c'], 4],
  ];

  test.each(bruteForceCases)('%s', (_name, grammar, alphabet, maxLen) => {
    const language = languageUpTo(grammar, maxLen);
    expect(language.size).toBeGreaterThan(0); // the test itself must be non-trivial

    for (const candidate of allStringsOver(alphabet, maxLen)) {
      // Wrapped in an object so a failure names the offending string.
      expect({ s: candidate, member: runEarley(grammar, candidate).accepted }).toEqual({
        s: candidate,
        member: language.has(candidate),
      });
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Cross-check 2 — agreement with CYK over the CNF conversion                */
/* ------------------------------------------------------------------------ */

describe('agreement with CYK on the CNF conversion', () => {
  // Earley runs on the ORIGINAL grammar, CYK on its CNF conversion. The two
  // share no code path beyond core/grammar.js, so any disagreement is a real
  // bug in one of them.
  const crossCases = [
    ['a^n b^n', anbn(), ['a', 'b'], 5],
    ['palindromes', palindromes(), ['a', 'b'], 5],
    ["equal numbers of a's and b's", equalAsBs(), ['a', 'b'], 5],
    ['balanced parentheses', balancedParentheses(), ['(', ')'], 5],
    ['arithmetic expressions', arithmetic(), ['a', '+', '*', '(', ')'], 4],
  ];

  test.each(crossCases)('%s', (_name, grammar, alphabet, maxLen) => {
    const cnf = convertToCnf(grammar).result;

    for (const candidate of allStringsOver(alphabet, maxLen)) {
      const earley = runEarley(grammar, candidate).accepted;
      const cyk = runCyk(cnf, candidate).accepted;
      expect({ s: candidate, verdict: earley }).toEqual({ s: candidate, verdict: cyk });
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Cross-check 3 — the tree is a tree OF THE ORIGINAL GRAMMAR                */
/* ------------------------------------------------------------------------ */

/**
 * Assert that a node applies a genuine production of the original grammar,
 * that its children spell that production's right-hand side, and that their
 * spans tile the parent's span exactly — then recurse. Frontier alone would
 * not catch a tree with the right leaves but invented internal structure.
 */
function checkNode(node, keys) {
  if (node.terminal) return;

  expect(keys.has(productionKey(node.production))).toBe(true);

  const spelled = node.children.filter((child) => !child.epsilon).map((child) => child.symbol);
  expect(spelled).toEqual(node.production.right);

  let cursor = node.span.i;
  for (const child of node.children) {
    if (child.epsilon) continue;
    expect(child.span.i).toBe(cursor);
    cursor += child.span.l;
  }
  expect(cursor).toBe(node.span.i + node.span.l);

  for (const child of node.children) checkNode(child, keys);
}

describe('tree correctness (in the ORIGINAL grammar)', () => {
  const treeCases = [
    ['a^n b^n', anbn(), ['', 'ab', 'aabb', 'aaabbb']],
    ['balanced parentheses', balancedParentheses(), ['', '()', '(())', '()()', '(()())']],
    ['palindromes', palindromes(), ['a', 'aba', 'abba', 'babab']],
    ['arithmetic expressions', arithmetic(), ['a', 'a+a', 'a+a*a', '(a+a)*a']],
    ["equal numbers of a's and b's", equalAsBs(), ['ab', 'ba', 'abba', 'aabb']],
    ['nullable stress', lateNullable(), ['c']],
  ];

  test.each(treeCases)('%s', (_name, grammar, inputs) => {
    const keys = new Set(grammar.productions.map(productionKey));

    for (const input of inputs) {
      const result = runEarley(grammar, input);
      expect({ s: input, accepted: result.accepted }).toEqual({ s: input, accepted: true });

      const tree = buildEarleyTree(result);

      // 1. the leaves, left to right, spell the input exactly
      expect({ s: input, spelled: frontier(tree).join('') }).toEqual({ s: input, spelled: input });
      // 2. the root is the start symbol and spans the whole string
      expect(tree.symbol).toBe(grammar.startSymbol);
      expect(tree.span).toEqual({ i: 0, l: input.length });
      // 3. every internal node applies a REAL production of this grammar
      checkNode(tree, keys);
    }
  });

  test('a rejected input has no tree', () => {
    expect(buildEarleyTree(runEarley(anbn(), 'aab'))).toBeNull();
  });

  test('a missing result has no tree', () => {
    expect(buildEarleyTree(null)).toBeNull();
    expect(buildEarleyTree(undefined)).toBeNull();
  });

  test("core/parser.js's tree helpers accept an Earley tree unchanged", () => {
    // They walk the node SHAPE, not the CYK table — so they are shared, not
    // reimplemented here.
    const tree = buildEarleyTree(runEarley(anbn(), 'aabb'));
    expect(countNodes(tree)).toBeGreaterThan(0);
    expect(treeDepth(tree)).toBeGreaterThan(1);

    const derivation = leftmostDerivation(tree);
    expect(derivation[0]).toEqual(['S']);
    expect(derivation[derivation.length - 1]).toEqual(['a', 'a', 'b', 'b']);
  });
});

/* ------------------------------------------------------------------------ */
/* Left recursion                                                            */
/* ------------------------------------------------------------------------ */

describe('left recursion (the arithmetic sample)', () => {
  // E → E + T and T → T * F are directly left-recursive: a naive
  // recursive-descent parser loops forever on them. That these tests
  // terminate at all is the assertion.
  const grammar = arithmetic();

  test.each(labelled(['a', 'a+a', 'a+a*a', '(a+a)*a', 'a+a+a+a', '((a))']))(
    'accepts %s without looping',
    (_label, s) => {
      expect(runEarley(grammar, s).accepted).toBe(true);
    }
  );

  test.each(labelled(['', 'a+', '*a', '(a', 'a++a', ')a(']))('rejects %s', (_label, s) => {
    expect(runEarley(grammar, s).accepted).toBe(false);
  });

  test('the tree uses the left-recursive production E → E + T itself', () => {
    const tree = buildEarleyTree(runEarley(grammar, 'a+a*a'));
    expect(productionKey(tree.production)).toBe(
      productionKey({ left: 'E', right: ['E', '+', 'T'] })
    );
    expect(frontier(tree).join('')).toBe('a+a*a');
  });
});

/* ------------------------------------------------------------------------ */
/* Chart and trace anatomy                                                   */
/* ------------------------------------------------------------------------ */

describe('chart and trace anatomy', () => {
  test('the chart has n + 1 columns, seeded with the start symbol rules', () => {
    const result = runEarley(anbn(), 'aabb');

    expect(result.chart).toHaveLength(result.n + 1);
    expect(result.chart.map((column) => column.index)).toEqual([0, 1, 2, 3, 4]);

    // anbn has exactly two S-rules, so column 0 opens with both, dotted at
    // the front and originating in column 0.
    const seeded = result.chart[0].items.slice(0, 2);
    expect(seeded.map((item) => item.production.left)).toEqual(['S', 'S']);
    expect(seeded.map((item) => item.dot)).toEqual([0, 0]);
    expect(seeded.map((item) => item.origin)).toEqual([0, 0]);
    expect(seeded.map((item) => item.derivations)).toEqual([[], []]);
  });

  test('the trace opens with begin, closes with verdict, and uses six types', () => {
    const { steps } = runEarley(anbn(), 'ab');

    expect(steps[0].type).toBe('begin');
    expect(steps[steps.length - 1]).toMatchObject({ type: 'verdict', accepted: true });
    expect(new Set(steps.map((step) => step.type))).toEqual(
      new Set(['begin', 'predict', 'scan', 'complete', 'column-done', 'verdict'])
    );

    for (const step of steps) {
      expect(typeof step.explanation).toBe('string');
      expect(step.explanation.length).toBeGreaterThan(0);
    }
  });

  test('one column-done step is emitted per column', () => {
    const { steps } = runEarley(anbn(), 'aabb');
    const done = steps.filter((step) => step.type === 'column-done');
    expect(done.map((step) => step.column)).toEqual([0, 1, 2, 3, 4]);
  });

  test('a nullable grammar produces at least one ε-repair completion', () => {
    const { steps } = runEarley(lateNullable(), 'c');
    const repairs = steps.filter((step) => step.type === 'complete' && step.nullableRepair);

    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs[0].explanation).toContain('ε');
  });

  test('the result is plain JSON and survives a round trip', () => {
    const result = runEarley(anbn(), 'ab');
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test('itemToString renders the dot and the origin', () => {
    expect(itemToString({ production: { left: 'S', right: ['a', 'S', 'b'] }, dot: 1, origin: 0 })).toBe(
      'S → a • S b (0)'
    );
    expect(itemToString({ production: { left: 'A', right: [] }, dot: 0, origin: 2 })).toBe(
      'A → • (2)'
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Typed errors                                                              */
/* ------------------------------------------------------------------------ */

describe('typed errors', () => {
  test('refuses a grammar that does not validate', () => {
    const broken = createGrammar({
      variables: ['S'],
      terminals: ['a'],
      startSymbol: 'X', // never declared
      productions: [{ left: 'S', right: ['a'] }],
    });

    expect(() => runEarley(broken, 'a')).toThrow(
      expect.objectContaining({ code: 'GRAMMAR_INVALID' })
    );
  });

  test('refuses a non-string input', () => {
    expect(() => runEarley(anbn(), null)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    expect(() => runEarley(anbn(), 42)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });

  test('refuses over-long inputs', () => {
    expect(() => runEarley(anbn(), 'a'.repeat(MAX_INPUT_LENGTH + 1))).toThrow(
      expect.objectContaining({ code: 'INPUT_TOO_LONG' })
    );
    expect(() => runEarley(anbn(), 'a'.repeat(MAX_INPUT_LENGTH))).not.toThrow();
  });

  test('refuses characters outside Σ and names the position', () => {
    expect(() => runEarley(anbn(), 'axb')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT_CHAR' })
    );

    try {
      runEarley(anbn(), 'axb');
    } catch (err) {
      expect(err.name).toBe('EarleyError');
      expect(err.message).toContain('position 2');
    }
  });
});
