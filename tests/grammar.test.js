/**
 * tests/grammar.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for the grammar data model (core/grammar.js): symbol
 * conventions, longest-match tokenization, production-line parsing,
 * formatting, saved test strings and JSON (de)serialization.
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

/* ------------------------------------------------------------------------ */
/* Test strings                                                              */
/* ------------------------------------------------------------------------ */

describe('testStrings on the grammar model', () => {
  test('defaults to two empty lists', () => {
    expect(createGrammar({}).testStrings).toEqual({ accept: [], reject: [] });
    expect(createEmptyGrammar().testStrings).toEqual({ accept: [], reject: [] });
  });

  test('keeps the lists it is given, in order', () => {
    const grammar = createGrammar({
      testStrings: { accept: ['()', '(())'], reject: ['(', ')('] },
    });
    expect(grammar.testStrings).toEqual({ accept: ['()', '(())'], reject: ['(', ')('] });
  });

  test('KEEPS the empty string — "" is ε, a legitimate test case', () => {
    // The regression this guards: variables and terminals drop empty
    // entries, and copying that filter here would silently delete the ε
    // case from four of the six built-in samples.
    const grammar = createGrammar({ testStrings: { accept: [''], reject: [''] } });
    expect(grammar.testStrings.accept).toEqual(['']);
    expect(grammar.testStrings.reject).toEqual(['']);
  });

  test('does not trim — the model never rewrites stored data', () => {
    expect(createGrammar({ testStrings: { accept: [' a '] } }).testStrings.accept).toEqual([' a ']);
  });

  test('drops entries that are not strings', () => {
    const grammar = createGrammar({
      testStrings: { accept: ['a', 1, null, undefined, {}], reject: [['b']] },
    });
    expect(grammar.testStrings).toEqual({ accept: ['a'], reject: [] });
  });

  test('survives a missing, null or non-array field', () => {
    expect(createGrammar({ testStrings: null }).testStrings).toEqual({ accept: [], reject: [] });
    expect(createGrammar({ testStrings: {} }).testStrings).toEqual({ accept: [], reject: [] });
    expect(createGrammar({ testStrings: { accept: 'a' } }).testStrings).toEqual({
      accept: [],
      reject: [],
    });
  });

  test('cloneGrammar deep-copies them', () => {
    const original = createGrammar({ testStrings: { accept: ['a'], reject: ['b'] } });
    const copy = cloneGrammar(original);
    copy.testStrings.accept.push('c');
    expect(original.testStrings.accept).toEqual(['a']);
  });
});

describe('test strings through (de)serialization', () => {
  const withStrings = () =>
    createGrammar({
      name: 'Balanced',
      variables: ['S'],
      terminals: ['(', ')'],
      startSymbol: 'S',
      productions: [{ left: 'S', right: [] }],
      testStrings: { accept: ['', '()'], reject: ['('] },
    });

  test('round-trips through the export envelope', () => {
    const result = deserializeGrammar(serializeGrammar(withStrings()));
    expect(result.ok).toBe(true);
    expect(result.grammar.testStrings).toEqual({ accept: ['', '()'], reject: ['('] });
  });

  test('imports a bare object carrying them', () => {
    const result = deserializeGrammar({
      variables: ['S'],
      terminals: ['a'],
      startSymbol: 'S',
      productions: [],
      testStrings: { accept: ['a'], reject: [] },
    });
    expect(result.ok).toBe(true);
    expect(result.grammar.testStrings).toEqual({ accept: ['a'], reject: [] });
  });

  test('accepts a grammar exported BEFORE test strings existed', () => {
    // Backward compatibility: every file exported by an earlier build has no
    // such key, and those must keep importing cleanly.
    const result = deserializeGrammar({
      variables: ['S'],
      terminals: ['a'],
      startSymbol: 'S',
      productions: [],
    });
    expect(result.ok).toBe(true);
    expect(result.grammar.testStrings).toEqual({ accept: [], reject: [] });
  });

  test('rejects a malformed testStrings field', () => {
    const base = { variables: ['S'], terminals: ['a'], startSymbol: 'S', productions: [] };
    expect(deserializeGrammar({ ...base, testStrings: [] }).ok).toBe(false);
    expect(deserializeGrammar({ ...base, testStrings: 'a' }).ok).toBe(false);
    expect(deserializeGrammar({ ...base, testStrings: { accept: [1] } }).ok).toBe(false);
    expect(deserializeGrammar({ ...base, testStrings: { reject: 'a' } }).ok).toBe(false);
  });
});
