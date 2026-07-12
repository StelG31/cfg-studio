/**
 * tests/validator.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for core/validator.js. Assertions target the stable finding
 * CODES (never message wording) plus the two exported fixpoint analyses.
 */

import { validateGrammar, computeGenerating, computeReachable } from '../core/validator.js';
import { createGrammar } from '../core/grammar.js';
import {
  anbn,
  balancedParentheses,
  arithmetic,
  withUselessSymbols,
  emptyLanguage,
} from './fixtures/grammars.js';

/** Convenience: the set of codes among a finding list. */
const codes = (findings) => findings.map((f) => f.code);

describe('valid grammars', () => {
  test.each([
    ['a^n b^n', anbn()],
    ['balanced parentheses', balancedParentheses()],
    ['arithmetic expressions', arithmetic()],
  ])('%s validates without errors or warnings', (_name, grammar) => {
    const result = validateGrammar(grammar);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('declaration errors', () => {
  test('empty grammar: no variables, no productions, no start symbol', () => {
    const result = validateGrammar(createGrammar({}));
    expect(result.valid).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining(['NO_VARIABLES', 'MISSING_START', 'NO_PRODUCTIONS'])
    );
  });

  test('invalid variable and terminal names are reported individually', () => {
    const result = validateGrammar(
      createGrammar({
        variables: ['S', 'bad'],
        terminals: ['a', 'XX'],
        startSymbol: 'S',
        productions: [{ left: 'S', right: ['a'] }],
      })
    );
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining(['INVALID_VARIABLE_NAME', 'INVALID_TERMINAL_SYMBOL'])
    );
    const badVariable = result.errors.find((e) => e.code === 'INVALID_VARIABLE_NAME');
    expect(badVariable.context.symbol).toBe('bad');
  });

  test('duplicate declarations are flagged once per symbol', () => {
    const result = validateGrammar(
      createGrammar({
        variables: ['S', 'S', 'S'],
        terminals: ['a', 'a'],
        startSymbol: 'S',
        productions: [{ left: 'S', right: ['a'] }],
      })
    );
    expect(codes(result.errors).filter((c) => c === 'DUPLICATE_VARIABLE')).toHaveLength(1);
    expect(codes(result.errors).filter((c) => c === 'DUPLICATE_TERMINAL')).toHaveLength(1);
  });
});

describe('start symbol errors', () => {
  test('missing start symbol', () => {
    const grammar = anbn();
    grammar.startSymbol = '';
    expect(codes(validateGrammar(grammar).errors)).toContain('MISSING_START');
  });

  test('start symbol not among the declared variables', () => {
    const grammar = anbn();
    grammar.startSymbol = 'Q';
    expect(codes(validateGrammar(grammar).errors)).toContain('START_NOT_DECLARED');
  });
});

describe('production errors', () => {
  test('left-hand side must be a declared variable', () => {
    const grammar = anbn();
    grammar.productions.push({ left: 'X', right: ['a'] });
    const result = validateGrammar(grammar);
    expect(codes(result.errors)).toContain('INVALID_PRODUCTION_LHS');
  });

  test('undefined symbols in the right-hand side are reported with the symbol', () => {
    const grammar = anbn();
    grammar.productions.push({ left: 'S', right: ['a', 'Q', 'b'] });
    const result = validateGrammar(grammar);
    const finding = result.errors.find((e) => e.code === 'UNDEFINED_SYMBOL');
    expect(finding).toBeDefined();
    expect(finding.context.symbol).toBe('Q');
  });

  test('duplicated productions are detected (including ε-productions)', () => {
    const grammar = anbn();
    grammar.productions.push({ left: 'S', right: [] }); // duplicate of existing ε rule
    expect(codes(validateGrammar(grammar).errors)).toContain('DUPLICATE_PRODUCTION');
  });
});

describe('warnings (useless structure)', () => {
  test('unreachable and non-generating variables, unused terminals', () => {
    const result = validateGrammar(withUselessSymbols());
    expect(result.valid).toBe(true); // warnings do not invalidate
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining(['UNREACHABLE_VARIABLE', 'NONGENERATING_VARIABLE', 'UNUSED_TERMINAL'])
    );
  });

  test('a non-generating start symbol earns the EMPTY_LANGUAGE warning', () => {
    const result = validateGrammar(emptyLanguage());
    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toContain('EMPTY_LANGUAGE');
  });

  test('warnings are suppressed while errors exist', () => {
    const grammar = withUselessSymbols();
    grammar.startSymbol = ''; // introduce an error
    const result = validateGrammar(grammar);
    expect(result.valid).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

describe('fixpoint analyses', () => {
  test('computeGenerating finds exactly the generating variables', () => {
    const generating = computeGenerating(withUselessSymbols());
    expect(generating).toEqual(new Set(['S', 'B'])); // C has no terminating rule
  });

  test('computeReachable follows productions from the start symbol only', () => {
    const reachable = computeReachable(withUselessSymbols());
    expect(reachable).toEqual(new Set(['S', 'C'])); // B is never referenced from S
  });

  test('computeReachable returns an empty set when the start symbol is invalid', () => {
    const grammar = anbn();
    grammar.startSymbol = 'Q';
    expect(computeReachable(grammar).size).toBe(0);
  });

  test('ε-productions make a variable generating', () => {
    expect(computeGenerating(anbn())).toEqual(new Set(['S']));
  });
});
