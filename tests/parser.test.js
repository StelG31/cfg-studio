/**
 * tests/parser.test.js
 * ---------------------------------------------------------------------------
 * Tests for parse-tree reconstruction (core/parser.js): tree structure,
 * frontier correctness, production validity, ε handling, leftmost
 * derivations, and rejected inputs.
 */

import { runCyk } from '../core/cyk.js';
import { convertToCnf } from '../core/cnf.js';
import { productionKey } from '../core/grammar.js';
import {
  buildParseTree,
  leftmostDerivation,
  countNodes,
  treeDepth,
  frontier,
} from '../core/parser.js';
import { anbn, arithmetic, alreadyCnf } from './fixtures/grammars.js';

const cnfAnbn = convertToCnf(anbn()).result;
const cnfArithmetic = convertToCnf(arithmetic()).result;

describe('tree structure (aabb over CNF(a^n b^n))', () => {
  const result = runCyk(cnfAnbn, 'aabb');
  const tree = buildParseTree(result);

  test('the root is the start symbol spanning the whole input', () => {
    expect(tree.symbol).toBe(result.startSymbol);
    expect(tree.span).toEqual({ i: 0, l: 4 });
  });

  test('the frontier spells the input string left to right', () => {
    expect(frontier(tree).join('')).toBe('aabb');
  });

  test('every internal node uses a production of the grammar', () => {
    const keys = new Set(cnfAnbn.productions.map(productionKey));
    const walk = (node) => {
      if (node.terminal) return;
      expect(keys.has(productionKey(node.production))).toBe(true);
      node.children.forEach(walk);
    };
    walk(tree);
  });

  test('a CNF derivation of n=4 has exactly n leaves and 2n-1 variable nodes', () => {
    // n terminal leaves + n pre-terminal nodes + (n-1) binary nodes = 3n-1
    expect(countNodes(tree)).toBe(3 * 4 - 1);
    expect(treeDepth(tree)).toBeGreaterThanOrEqual(3);
  });

  test('binary nodes split the span consistently', () => {
    const walk = (node) => {
      if (node.terminal || node.children.length !== 2) return;
      const [left, right] = node.children;
      expect(left.span.i).toBe(node.span.i);
      expect(left.span.l + right.span.l).toBe(node.span.l);
      expect(right.span.i).toBe(node.span.i + left.span.l);
      node.children.forEach(walk);
    };
    walk(tree);
  });
});

describe('special cases', () => {
  test('ε yields the two-node tree S → ε', () => {
    const tree = buildParseTree(runCyk(cnfAnbn, ''));
    expect(tree.symbol).toBe(cnfAnbn.startSymbol);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].epsilon).toBe(true);
    expect(frontier(tree)).toEqual([]); // ε contributes nothing to the frontier
  });

  test('rejected inputs produce no tree', () => {
    expect(buildParseTree(runCyk(cnfAnbn, 'aab'))).toBeNull();
  });

  test('a hand-written CNF grammar parses without conversion', () => {
    const tree = buildParseTree(runCyk(alreadyCnf(), 'ab'));
    expect(frontier(tree).join('')).toBe('ab');
    expect(tree.children.map((c) => c.symbol)).toEqual(['A', 'B']);
  });

  test('arithmetic: the frontier of "a+a*a" is the input', () => {
    const tree = buildParseTree(runCyk(cnfArithmetic, 'a+a*a'));
    expect(frontier(tree).join('')).toBe('a+a*a');
  });
});

describe('leftmost derivation', () => {
  test('starts at [S], ends at the input, and changes one variable per step', () => {
    const result = runCyk(cnfAnbn, 'aabb');
    const tree = buildParseTree(result);
    const forms = leftmostDerivation(tree);

    expect(forms[0]).toEqual([result.startSymbol]);
    expect(forms.at(-1).join('')).toBe('aabb');

    const variables = new Set(cnfAnbn.variables);
    for (let step = 1; step < forms.length; step += 1) {
      const previous = forms[step - 1];
      // The expanded symbol is the LEFTMOST variable of the previous form.
      const leftmostVariable = previous.findIndex((s) => variables.has(s));
      expect(leftmostVariable).toBeGreaterThanOrEqual(0);
      // Everything before it (pure terminals) is preserved verbatim.
      expect(forms[step].slice(0, leftmostVariable)).toEqual(
        previous.slice(0, leftmostVariable)
      );
    }
  });

  test('the ε tree derives S ⇒ ε (an empty final form)', () => {
    const tree = buildParseTree(runCyk(cnfAnbn, ''));
    const forms = leftmostDerivation(tree);
    expect(forms[0]).toEqual([cnfAnbn.startSymbol]);
    expect(forms.at(-1)).toEqual([]);
  });
});
