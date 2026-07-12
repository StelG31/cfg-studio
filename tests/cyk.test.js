/**
 * tests/cyk.test.js
 * ---------------------------------------------------------------------------
 * Tests for the CYK algorithm (core/cyk.js):
 *   - membership decisions on every sample grammar (after CNF conversion),
 *   - an exhaustive cross-check against brute-force enumeration,
 *   - ε handling, table structure, backpointers, step-trace shape,
 *   - typed error conditions.
 */

import { runCyk, MAX_INPUT_LENGTH } from '../core/cyk.js';
import { convertToCnf } from '../core/cnf.js';
import { languageUpTo } from './helpers.js';
import {
  anbn,
  balancedParentheses,
  arithmetic,
  palindromes,
  alreadyCnf,
} from './fixtures/grammars.js';

/** Convert a fixture once and reuse the CNF grammar across a suite. */
const cnfOf = (grammar) => convertToCnf(grammar).result;

/* ------------------------------------------------------------------------ */
/* Membership decisions (the expected outputs for each example grammar)      */
/* ------------------------------------------------------------------------ */

describe('membership on the sample grammars (via CNF conversion)', () => {
  const cases = [
    {
      name: 'a^n b^n',
      grammar: cnfOf(anbn()),
      accept: ['', 'ab', 'aabb', 'aaabbb'],
      reject: ['a', 'b', 'ba', 'aab', 'abab', 'bbaa'],
    },
    {
      name: 'balanced parentheses',
      grammar: cnfOf(balancedParentheses()),
      accept: ['', '()', '()()', '(())', '(()())', '((()))'],
      reject: ['(', ')', ')(', '())', '(()'],
    },
    {
      name: 'arithmetic expressions',
      grammar: cnfOf(arithmetic()),
      accept: ['a', 'a+a', 'a*a', 'a+a*a', '(a+a)*a', '(a)', '((a))'],
      reject: ['', '+', 'a+', '*a', '(a', 'aa', 'a++a', '()'],
    },
    {
      name: 'palindromes',
      grammar: cnfOf(palindromes()),
      accept: ['', 'a', 'b', 'aa', 'aba', 'abba', 'babab'],
      reject: ['ab', 'ba', 'aab', 'abab'],
    },
  ];

  for (const { name, grammar, accept, reject } of cases) {
    describe(name, () => {
      test.each(accept.map((s) => [s === '' ? 'ε' : s, s]))('accepts %s', (_label, s) => {
        expect(runCyk(grammar, s).accepted).toBe(true);
      });
      test.each(reject.map((s) => [s === '' ? 'ε' : s, s]))('rejects %s', (_label, s) => {
        expect(runCyk(grammar, s).accepted).toBe(false);
      });
    });
  }
});

describe('exhaustive cross-check against brute-force enumeration', () => {
  test('CYK agrees with languageUpTo on EVERY {a,b}-string up to length 5 (a^n b^n)', () => {
    const grammar = cnfOf(anbn());
    const language = languageUpTo(grammar, 5);

    const allStrings = [''];
    for (let length = 1; length <= 5; length += 1) {
      for (let mask = 0; mask < 2 ** length; mask += 1) {
        allStrings.push(
          [...Array(length)].map((_, bit) => ((mask >> bit) & 1 ? 'b' : 'a')).join('')
        );
      }
    }

    for (const candidate of allStrings) {
      expect({ s: candidate, member: runCyk(grammar, candidate).accepted }).toEqual({
        s: candidate,
        member: language.has(candidate),
      });
    }
  });
});

/* ------------------------------------------------------------------------ */
/* ε handling and CNF grammars used directly                                 */
/* ------------------------------------------------------------------------ */

describe('special cases', () => {
  test('a hand-written CNF grammar runs without conversion', () => {
    const grammar = alreadyCnf(); // S → AB, A → a, B → b
    expect(runCyk(grammar, 'ab').accepted).toBe(true);
    expect(runCyk(grammar, 'ba').accepted).toBe(false);
    expect(runCyk(grammar, '').accepted).toBe(false); // no S → ε rule
  });

  test('the empty string is decided by the S → ε rule alone (no table)', () => {
    const result = runCyk(cnfOf(anbn()), '');
    expect(result.accepted).toBe(true);
    expect(result.table).toEqual([]);
    expect(result.steps.map((s) => s.type)).toEqual(['begin', 'verdict']);
  });
});

/* ------------------------------------------------------------------------ */
/* Table structure, backpointers, step trace                                 */
/* ------------------------------------------------------------------------ */

describe('table and trace anatomy (aabb over CNF(a^n b^n))', () => {
  const grammar = cnfOf(anbn());
  const result = runCyk(grammar, 'aabb');

  test('the base row matches the terminal rules', () => {
    // input[0] = 'a' → T_a (the TERM-stage variable)
    expect(result.table[1][0].entries.map((e) => e.variable)).toContain('T_a');
    // input[3] = 'b' → T_b and X1 (X1 → b exists after UNIT)
    const vars = result.table[1][3].entries.map((e) => e.variable);
    expect(vars).toEqual(expect.arrayContaining(['T_b']));
  });

  test('the apex cell contains the start symbol with a split backpointer', () => {
    const apex = result.table[4][0];
    const startEntry = apex.entries.find((e) => e.variable === result.startSymbol);
    expect(startEntry).toBeDefined();
    expect(startEntry.derivations[0].type).toBe('split');
    expect(startEntry.derivations[0].k).toBeGreaterThanOrEqual(1);
    expect(startEntry.derivations[0].production.right).toHaveLength(2);
  });

  test('the step trace has the exact expected shape for n = 4', () => {
    const types = result.steps.map((s) => s.type);
    expect(types[0]).toBe('begin');
    expect(types.at(-1)).toBe('verdict');
    expect(types.filter((t) => t === 'init-cell')).toHaveLength(4);
    // combines: Σ over l=2..4 of (n-l+1)(l-1) = 3·1 + 2·2 + 1·3 = 10
    expect(types.filter((t) => t === 'combine')).toHaveLength(10);
    // one cell-done per cell of length ≥ 2: 3 + 2 + 1 = 6
    expect(types.filter((t) => t === 'cell-done')).toHaveLength(6);
    // every step carries a human-readable explanation
    for (const step of result.steps) {
      expect(typeof step.explanation).toBe('string');
      expect(step.explanation.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Error conditions                                                          */
/* ------------------------------------------------------------------------ */

describe('typed errors', () => {
  test('refuses a grammar that is not in CNF', () => {
    expect(() => runCyk(anbn(), 'ab')).toThrow(
      expect.objectContaining({ code: 'GRAMMAR_NOT_CNF' })
    );
  });

  test('refuses characters outside the alphabet, naming the position', () => {
    expect(() => runCyk(cnfOf(anbn()), 'axb')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT_CHAR' })
    );
    try {
      runCyk(cnfOf(anbn()), 'axb');
    } catch (err) {
      expect(err.message).toContain('position 2');
    }
  });

  test('refuses over-long inputs', () => {
    expect(() => runCyk(cnfOf(anbn()), 'a'.repeat(MAX_INPUT_LENGTH + 1))).toThrow(
      expect.objectContaining({ code: 'INPUT_TOO_LONG' })
    );
  });

  test('refuses non-string input', () => {
    expect(() => runCyk(cnfOf(anbn()), 42)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });
});
