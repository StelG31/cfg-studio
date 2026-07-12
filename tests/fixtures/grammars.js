/**
 * tests/fixtures/grammars.js
 * ---------------------------------------------------------------------------
 * Shared example grammars used across the test suites (validator, CNF, CYK,
 * parser). Each fixture is a FACTORY returning a fresh object, so one test
 * mutating a grammar can never contaminate another.
 *
 * The `cyk` field of each entry documents expected membership results and
 * doubles as the specification the CYK tests assert against.
 */

import { createGrammar } from '../../core/grammar.js';

/** L = { aⁿbⁿ | n ≥ 0 } */
export function anbn() {
  return createGrammar({
    name: 'a^n b^n',
    variables: ['S'],
    terminals: ['a', 'b'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['a', 'S', 'b'] },
      { left: 'S', right: [] },
    ],
  });
}

/** L = balanced strings of parentheses */
export function balancedParentheses() {
  return createGrammar({
    name: 'Balanced Parentheses',
    variables: ['S'],
    terminals: ['(', ')'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['(', 'S', ')'] },
      { left: 'S', right: ['S', 'S'] },
      { left: 'S', right: [] },
    ],
  });
}

/** Classic ambiguous-free arithmetic expression grammar (identifiers = a). */
export function arithmetic() {
  return createGrammar({
    name: 'Arithmetic Expressions',
    variables: ['E', 'T', 'F'],
    terminals: ['a', '+', '*', '(', ')'],
    startSymbol: 'E',
    productions: [
      { left: 'E', right: ['E', '+', 'T'] },
      { left: 'E', right: ['T'] },
      { left: 'T', right: ['T', '*', 'F'] },
      { left: 'T', right: ['F'] },
      { left: 'F', right: ['(', 'E', ')'] },
      { left: 'F', right: ['a'] },
    ],
  });
}

/** L = even-length palindromes plus single letters over {a, b} */
export function palindromes() {
  return createGrammar({
    name: 'Palindromes over {a,b}',
    variables: ['S'],
    terminals: ['a', 'b'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['a', 'S', 'a'] },
      { left: 'S', right: ['b', 'S', 'b'] },
      { left: 'S', right: ['a'] },
      { left: 'S', right: ['b'] },
      { left: 'S', right: [] },
    ],
  });
}

/** Grammar with an unreachable variable (B) and an unused terminal (c). */
export function withUselessSymbols() {
  return createGrammar({
    name: 'Useless symbols demo',
    variables: ['S', 'B', 'C'],
    terminals: ['a', 'b', 'c'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['a'] },
      { left: 'B', right: ['b'] }, // B unreachable from S
      { left: 'S', right: ['C', 'a'] },
      { left: 'C', right: ['C', 'a'] }, // C non-generating (no base case)
    ],
  });
}

/** Start symbol never terminates: L(G) = ∅. */
export function emptyLanguage() {
  return createGrammar({
    name: 'Empty language',
    variables: ['S'],
    terminals: ['a'],
    startSymbol: 'S',
    productions: [{ left: 'S', right: ['a', 'S'] }],
  });
}

/** Already in Chomsky Normal Form (used by CNF tests). */
export function alreadyCnf() {
  return createGrammar({
    name: 'Already CNF',
    variables: ['S', 'A', 'B'],
    terminals: ['a', 'b'],
    startSymbol: 'S',
    productions: [
      { left: 'S', right: ['A', 'B'] },
      { left: 'A', right: ['a'] },
      { left: 'B', right: ['b'] },
    ],
  });
}
