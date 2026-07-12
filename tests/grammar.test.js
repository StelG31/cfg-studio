/**
 * tests/grammar.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for the grammar data model (core/grammar.js): symbol
 * conventions, longest-match tokenization, production-line parsing,
 * formatting and JSON (de)serialization.
 */

import {
  EPSILON,
  isValidVariableName,
  isValidTerminalSymbol,
  createGrammar,
  createEmptyGrammar,
  cloneGrammar,
  productionKey,
  productionsEqual,
  tokenizeRhs,
  parseProductionLine,
  productionToString,
  grammarToText,
  serializeGrammar,
  deserializeGrammar,
} from '../core/grammar.js';

describe('symbol conventions', () => {
  test('valid variable names: uppercase start, then letters/digits/underscore', () => {
    for (const name of ['S', 'A', 'X1', 'T_a', 'Expr', 'S0']) {
      expect(isValidVariableName(name)).toBe(true);
    }
  });

  test('invalid variable names are rejected', () => {
    for (const name of ['s', '1A', '', 'A B', 'α', '_X', 'A-']) {
      expect(isValidVariableName(name)).toBe(false);
    }
  });

  test('valid terminals: single non-uppercase printable characters', () => {
    for (const symbol of ['a', 'z', '0', '9', '(', ')', '+', '*', '-', '>']) {
      expect(isValidTerminalSymbol(symbol)).toBe(true);
    }
  });

  test('invalid terminals: uppercase, multi-char, whitespace, reserved', () => {
    for (const symbol of ['A', 'ab', '', ' ', '|', 'ε', 'λ']) {
      expect(isValidTerminalSymbol(symbol)).toBe(false);
    }
  });
});

describe('createGrammar / cloneGrammar', () => {
  test('normalizes whitespace and drops empty entries', () => {
    const grammar = createGrammar({
      name: '  My grammar  ',
      variables: [' S ', '', 'A'],
      terminals: ['a', ' '],
      startSymbol: ' S ',
      productions: [{ left: ' S ', right: ['a'] }],
    });
    expect(grammar.name).toBe('My grammar');
    expect(grammar.variables).toEqual(['S', 'A']);
    expect(grammar.terminals).toEqual(['a']);
    expect(grammar.startSymbol).toBe('S');
    expect(grammar.productions).toEqual([{ left: 'S', right: ['a'] }]);
  });

  test('cloneGrammar returns an independent deep copy', () => {
    const grammar = createGrammar({ variables: ['S'], productions: [{ left: 'S', right: [] }] });
    const copy = cloneGrammar(grammar);
    copy.productions[0].right.push('x');
    expect(grammar.productions[0].right).toEqual([]);
  });

  test('createEmptyGrammar produces a blank, usable draft', () => {
    const grammar = createEmptyGrammar();
    expect(grammar.variables).toEqual([]);
    expect(grammar.productions).toEqual([]);
  });
});

describe('productionKey (duplicate identity)', () => {
  test('identical productions share a key', () => {
    expect(
      productionsEqual({ left: 'S', right: ['a', 'S'] }, { left: 'S', right: ['a', 'S'] })
    ).toBe(true);
  });

  test('the classic collision case: S → AB vs S → A B are DIFFERENT', () => {
    const oneSymbol = { left: 'S', right: ['AB'] };
    const twoSymbols = { left: 'S', right: ['A', 'B'] };
    expect(productionKey(oneSymbol)).not.toBe(productionKey(twoSymbols));
  });
});

describe('tokenizeRhs (longest-match scanning)', () => {
  const symbols = ['S', 'A', 'AB', 'a', 'b', '(', ')'];

  test('splits adjacent symbols without spaces', () => {
    expect(tokenizeRhs('aSb', symbols)).toEqual({ ok: true, tokens: ['a', 'S', 'b'] });
  });

  test('ignores whitespace between symbols', () => {
    expect(tokenizeRhs('  ( S )  ', symbols)).toEqual({ ok: true, tokens: ['(', 'S', ')'] });
  });

  test('longest match wins: AB is one symbol, not A then B', () => {
    expect(tokenizeRhs('ABa', symbols)).toEqual({ ok: true, tokens: ['AB', 'a'] });
  });

  test('reports the exact position of an unknown symbol', () => {
    const result = tokenizeRhs('aXb', symbols);
    expect(result.ok).toBe(false);
    expect(result.error.index).toBe(1);
  });

  test('empty text tokenizes to zero symbols', () => {
    expect(tokenizeRhs('', symbols)).toEqual({ ok: true, tokens: [] });
  });
});

describe('parseProductionLine', () => {
  const declared = { variables: ['S', 'A'], terminals: ['a', 'b', '(', ')'] };

  test('parses a simple production', () => {
    const result = parseProductionLine('S -> a S b', declared);
    expect(result).toEqual({ ok: true, productions: [{ left: 'S', right: ['a', 'S', 'b'] }] });
  });

  test('accepts the unicode arrow →', () => {
    const result = parseProductionLine('S → a', declared);
    expect(result.ok).toBe(true);
  });

  test('splits alternatives on | and understands ε aliases', () => {
    const result = parseProductionLine('S -> aSb | eps | ε', declared);
    expect(result.ok).toBe(true);
    expect(result.productions).toEqual([
      { left: 'S', right: ['a', 'S', 'b'] },
      { left: 'S', right: [] },
      { left: 'S', right: [] },
    ]);
  });

  test('rejects a line without an arrow', () => {
    const result = parseProductionLine('S a b', declared);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/arrow/i);
  });

  test('rejects an invalid left-hand side', () => {
    const result = parseProductionLine('s -> a', declared);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/not a valid variable/i);
  });

  test('rejects an empty alternative and suggests ε', () => {
    const result = parseProductionLine('S -> a | ', declared);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/ε/);
  });

  test('reports undeclared symbols in the right-hand side', () => {
    const result = parseProductionLine('S -> a X', declared);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/Cannot recognise/i);
  });

  test('terminals - and > survive despite the -> arrow (split on first arrow only)', () => {
    const withDash = { variables: ['S'], terminals: ['-', '>', 'a'] };
    const result = parseProductionLine('S -> a-a', withDash);
    expect(result).toEqual({ ok: true, productions: [{ left: 'S', right: ['a', '-', 'a'] }] });
  });
});

describe('formatting', () => {
  test('productionToString renders ε for empty right-hand sides', () => {
    expect(productionToString({ left: 'S', right: [] })).toBe(`S → ${EPSILON}`);
    expect(productionToString({ left: 'S', right: ['a', 'S'] })).toBe('S → a S');
  });

  test('grammarToText groups alternatives per variable, in first-appearance order', () => {
    const grammar = createGrammar({
      variables: ['S', 'A'],
      terminals: ['a', 'b'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: ['a', 'A'] },
        { left: 'A', right: ['b'] },
        { left: 'S', right: [] },
      ],
    });
    expect(grammarToText(grammar)).toBe(`S → a A | ${EPSILON}\nA → b`);
  });
});

describe('JSON (de)serialization', () => {
  const grammar = createGrammar({
    name: 'anbn',
    variables: ['S'],
    terminals: ['a', 'b'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['a', 'S', 'b'] },
      { left: 'S', right: [] },
    ],
  });

  test('round-trips through the export envelope', () => {
    const restored = deserializeGrammar(serializeGrammar(grammar));
    expect(restored.ok).toBe(true);
    expect(restored.grammar).toEqual(grammar);
  });

  test('accepts a bare grammar object without the envelope', () => {
    const restored = deserializeGrammar(JSON.stringify(grammar));
    expect(restored.ok).toBe(true);
    expect(restored.grammar.productions).toHaveLength(2);
  });

  test('rejects invalid JSON with a friendly message', () => {
    expect(deserializeGrammar('{ not json').ok).toBe(false);
  });

  test('rejects structurally broken grammars', () => {
    expect(deserializeGrammar(JSON.stringify({ variables: 'S' })).ok).toBe(false);
    expect(deserializeGrammar(JSON.stringify({ variables: [], terminals: [] })).ok).toBe(false);
    expect(
      deserializeGrammar(
        JSON.stringify({
          variables: ['S'],
          terminals: [],
          startSymbol: 'S',
          productions: [{ left: 'S' }], // missing right
        })
      ).ok
    ).toBe(false);
  });
});
