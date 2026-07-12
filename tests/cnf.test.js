/**
 * tests/cnf.test.js
 * ---------------------------------------------------------------------------
 * Tests for the CNF conversion pipeline (core/cnf.js):
 *   - per-stage invariants (START, TERM, BIN, DEL, UNIT, CLEANUP),
 *   - end-to-end structural CNF checks,
 *   - LANGUAGE PRESERVATION via brute-force enumeration (tests/helpers.js),
 *   - edge cases: ε ∈ L, already-CNF input, empty language, useless symbols.
 */

import {
  isCnf,
  convertToCnf,
  applyStart,
  applyTerm,
  applyBin,
  applyDel,
  applyUnit,
  removeUseless,
  computeNullable,
} from '../core/cnf.js';
import { createGrammar } from '../core/grammar.js';
import { validateGrammar } from '../core/validator.js';
import { languageUpTo } from './helpers.js';
import {
  anbn,
  balancedParentheses,
  arithmetic,
  palindromes,
  alreadyCnf,
  withUselessSymbols,
  emptyLanguage,
} from './fixtures/grammars.js';

/* ------------------------------------------------------------------------ */
/* isCnf                                                                     */
/* ------------------------------------------------------------------------ */

describe('isCnf', () => {
  test('recognises a CNF grammar', () => {
    expect(isCnf(alreadyCnf())).toBe(true);
  });

  test('rejects long rules, terminal mixes, unit and ε rules', () => {
    expect(isCnf(anbn())).toBe(false); // S → aSb (length 3) and S → ε
    expect(isCnf(arithmetic())).toBe(false); // E → T unit rules
  });

  test('allows S → ε only when the start symbol stays off right-hand sides', () => {
    const okay = createGrammar({
      variables: ['S', 'A', 'B'],
      terminals: ['a', 'b'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: [] },
        { left: 'S', right: ['A', 'B'] },
        { left: 'A', right: ['a'] },
        { left: 'B', right: ['b'] },
      ],
    });
    expect(isCnf(okay)).toBe(true);

    const startOnRhs = createGrammar({
      variables: ['S', 'A'],
      terminals: ['a'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: [] },
        { left: 'S', right: ['A', 'S'] }, // start on a right-hand side + S → ε
        { left: 'A', right: ['a'] },
      ],
    });
    expect(isCnf(startOnRhs)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Individual stages                                                         */
/* ------------------------------------------------------------------------ */

describe('START stage', () => {
  test('introduces a fresh start symbol when the start appears on a RHS', () => {
    const { grammar } = applyStart(anbn()); // S → aSb references S
    expect(grammar.startSymbol).toBe('S0');
    expect(grammar.productions[0]).toEqual({ left: 'S0', right: ['S'] });
  });

  test('is a no-op when the start symbol never appears on a RHS', () => {
    const { grammar, changes } = applyStart(alreadyCnf());
    expect(changes).toEqual([]);
    expect(grammar.startSymbol).toBe('S');
  });

  test('never collides with an existing S0', () => {
    const tricky = createGrammar({
      variables: ['S', 'S0'],
      terminals: ['a'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: ['S0', 'S'] },
        { left: 'S', right: ['a'] },
        { left: 'S0', right: ['a'] },
      ],
    });
    const { grammar } = applyStart(tricky);
    expect(grammar.startSymbol).toBe('S01'); // S0 is taken
  });
});

describe('TERM stage', () => {
  test('after TERM, no rule of length ≥ 2 contains a terminal', () => {
    const { grammar } = applyTerm(anbn());
    const terminals = new Set(grammar.terminals);
    for (const production of grammar.productions) {
      if (production.right.length >= 2) {
        expect(production.right.some((s) => terminals.has(s))).toBe(false);
      }
    }
  });

  test('reuses one replacement variable per terminal across all rules', () => {
    const { grammar } = applyTerm(palindromes()); // "a" appears in two long rules (aSa, and again in aSa's mirror)
    // Exactly ONE new replacement variable T_a was introduced...
    expect(grammar.variables.filter((v) => v === 'T_a')).toHaveLength(1);
    // ...and every long rule that contained "a" now uses that same variable.
    const longRules = grammar.productions.filter((p) => p.right.length >= 2);
    for (const production of longRules) {
      expect(production.right).not.toContain('a');
    }
    expect(
      grammar.productions.filter((p) => p.left === 'T_a' && p.right.join('') === 'a')
    ).toHaveLength(1);
  });

  test('non-alphanumeric terminals get sequential T names', () => {
    const { grammar } = applyTerm(balancedParentheses());
    expect(grammar.variables).toEqual(expect.arrayContaining(['T1', 'T2']));
  });
});

describe('BIN stage', () => {
  test('after BIN, every right-hand side has length ≤ 2', () => {
    const { grammar } = applyBin(applyTerm(anbn()).grammar);
    for (const production of grammar.productions) {
      expect(production.right.length).toBeLessThanOrEqual(2);
    }
  });

  test('cascade variables are X1, X2, ... in order', () => {
    const long = createGrammar({
      variables: ['S', 'A'],
      terminals: ['a'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: ['A', 'A', 'A', 'A'] }, // needs two cascade variables
        { left: 'A', right: ['a'] },
      ],
    });
    const { grammar } = applyBin(long);
    expect(grammar.variables).toEqual(expect.arrayContaining(['X1', 'X2']));
    expect(grammar.productions).toEqual(
      expect.arrayContaining([
        { left: 'S', right: ['A', 'X1'] },
        { left: 'X1', right: ['A', 'X2'] },
        { left: 'X2', right: ['A', 'A'] },
      ])
    );
  });
});

describe('DEL stage', () => {
  test('computeNullable finds transitive nullability', () => {
    const grammar = createGrammar({
      variables: ['S', 'A', 'B'],
      terminals: ['a'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: ['A', 'B'] },
        { left: 'A', right: ['B', 'B'] },
        { left: 'B', right: [] },
        { left: 'S', right: ['a'] },
      ],
    });
    expect(computeNullable(grammar)).toEqual(new Set(['S', 'A', 'B']));
  });

  test('after DEL, only the start symbol may have an ε-rule', () => {
    const prepared = applyBin(applyTerm(applyStart(anbn()).grammar).grammar).grammar;
    const { grammar } = applyDel(prepared);
    for (const production of grammar.productions) {
      if (production.right.length === 0) {
        expect(production.left).toBe(grammar.startSymbol);
      }
    }
    // ε ∈ L(anbn), so the start MUST keep its ε-rule.
    expect(
      grammar.productions.some(
        (p) => p.left === grammar.startSymbol && p.right.length === 0
      )
    ).toBe(true);
  });

  test('adds all subset variants of nullable occurrences', () => {
    const grammar = createGrammar({
      variables: ['S', 'A'],
      terminals: ['a', 'b'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: ['A', 'A'] },
        { left: 'A', right: ['a'] },
        { left: 'A', right: [] },
      ],
    });
    const del = applyDel(grammar).grammar;
    expect(del.productions).toEqual(
      expect.arrayContaining([
        { left: 'S', right: ['A', 'A'] },
        { left: 'S', right: ['A'] }, // either occurrence omitted (deduplicated)
        { left: 'S', right: [] }, // start is nullable → keeps ε
        { left: 'A', right: ['a'] },
      ])
    );
    // No duplicate S → A from omitting the two different positions:
    const sA = del.productions.filter((p) => p.left === 'S' && p.right.join() === 'A');
    expect(sA).toHaveLength(1);
  });
});

describe('UNIT stage', () => {
  test('collapses unit chains and removes all unit rules', () => {
    const { grammar } = applyUnit(arithmetic()); // E → T → F chains
    const variables = new Set(grammar.variables);
    for (const production of grammar.productions) {
      const isUnit = production.right.length === 1 && variables.has(production.right[0]);
      expect(isUnit).toBe(false);
    }
    // E must have inherited F's rule F → a through E ⇒* T ⇒* F.
    expect(grammar.productions).toEqual(
      expect.arrayContaining([{ left: 'E', right: ['a'] }])
    );
  });

  test('handles unit cycles without looping forever', () => {
    const cyclic = createGrammar({
      variables: ['S', 'A'],
      terminals: ['a'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: ['A'] },
        { left: 'A', right: ['S'] },
        { left: 'A', right: ['a'] },
      ],
    });
    const { grammar } = applyUnit(cyclic);
    expect(grammar.productions).toEqual(
      expect.arrayContaining([
        { left: 'S', right: ['a'] },
        { left: 'A', right: ['a'] },
      ])
    );
  });
});

describe('CLEANUP stage', () => {
  test('removes non-generating and unreachable variables', () => {
    const { grammar } = removeUseless(withUselessSymbols());
    expect(grammar.variables).toEqual(['S']); // B unreachable, C non-generating
    expect(grammar.productions).toEqual([{ left: 'S', right: ['a'] }]);
  });
});

/* ------------------------------------------------------------------------ */
/* Full pipeline                                                             */
/* ------------------------------------------------------------------------ */

describe('convertToCnf — structure', () => {
  test.each([
    ['a^n b^n', anbn()],
    ['balanced parentheses', balancedParentheses()],
    ['arithmetic expressions', arithmetic()],
    ['palindromes', palindromes()],
  ])('%s converts to a valid CNF grammar with 6 documented steps', (_name, grammar) => {
    const conversion = convertToCnf(grammar);
    expect(conversion.alreadyCnf).toBe(false);
    expect(conversion.steps).toHaveLength(6);
    expect(conversion.steps.map((s) => s.stage)).toEqual([
      'START',
      'TERM',
      'BIN',
      'DEL',
      'UNIT',
      'CLEANUP',
    ]);
    // The result is structurally CNF and passes the shared validator.
    expect(isCnf(conversion.result)).toBe(true);
    expect(validateGrammar(conversion.result).valid).toBe(true);
    // Every step carries a snapshot and an explanation.
    for (const step of conversion.steps) {
      expect(step.grammar.productions).toBeDefined();
      expect(step.explanation.length).toBeGreaterThan(0);
    }
  });

  test('an already-CNF grammar is reported as such, unchanged', () => {
    const conversion = convertToCnf(alreadyCnf());
    expect(conversion.alreadyCnf).toBe(true);
    expect(conversion.result).toEqual(alreadyCnf());
    expect(conversion.steps).toHaveLength(1);
  });

  test('an empty-language grammar yields the emptyLanguage flag', () => {
    const conversion = convertToCnf(emptyLanguage());
    expect(conversion.emptyLanguage).toBe(true);
    expect(conversion.result.productions).toEqual([]);
  });

  test('an invalid grammar is refused', () => {
    const broken = anbn();
    broken.startSymbol = 'Q';
    expect(() => convertToCnf(broken)).toThrow(/valid/i);
  });
});

describe('convertToCnf — language preservation (brute-force enumeration)', () => {
  test.each([
    ['a^n b^n', anbn(), 6],
    ['balanced parentheses', balancedParentheses(), 6],
    ['palindromes', palindromes(), 5],
  ])('%s: L(G) and L(CNF(G)) agree up to length %i', (_name, grammar, maxLen) => {
    const before = languageUpTo(grammar, maxLen);
    const after = languageUpTo(convertToCnf(grammar).result, maxLen);
    expect(after).toEqual(before);
    expect(before.size).toBeGreaterThan(0); // the test itself must be non-trivial
  });

  test('ε survives conversion exactly when ε ∈ L(G)', () => {
    expect(languageUpTo(convertToCnf(anbn()).result, 0).has('')).toBe(true); // ε ∈ anbn
    expect(languageUpTo(convertToCnf(arithmetic()).result, 0).has('')).toBe(false);
  });
});
