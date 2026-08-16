/**
 * core/earley.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The Earley parsing algorithm over an ARBITRARY context-free grammar —
 *   no Chomsky Normal Form conversion required (see docs/algorithms.md §6).
 *
 *   Besides the chart itself, runEarley records:
 *     - BACKPOINTERS on every item (how its dot reached its position) —
 *       consumed by core/earley-tree.js to rebuild a parse tree in the
 *       USER'S OWN productions,
 *     - a granular STEP TRACE (begin / predict / scan / complete /
 *       column-done / verdict) with human-readable explanations — for the UI
 *       to animate the chart column by column.
 *
 *   Chart addressing convention used everywhere in this module:
 *     column c holds every item whose dot sits just before 0-based input
 *     position c; an item's `origin` is the column it was predicted in. The
 *     user-facing explanations use 1-based positions.
 *
 *   Pure ES module — shared verbatim by the browser, the server and Jest.
 */

import { productionKey, productionToString } from './grammar.js';
import { validateGrammar } from './validator.js';

/** Hard cap on the input length: keeps the chart readable and the trace
 *  bounded. Matches the CYK simulator's cap and is far beyond any
 *  classroom example. */
export const MAX_INPUT_LENGTH = 30;

/** An Error subtype carrying a stable machine-readable code. */
class EarleyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EarleyError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------------ */
/* Item rendering                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Render an item as `A → α • β (j)` — the item analogue of
 * productionToString. Used by every trace explanation, and by the UI.
 *
 * @param {{production: object, dot: number, origin: number}} item
 * @returns {string}
 */
export function itemToString(item) {
  const { production, dot, origin } = item;
  const body = [...production.right.slice(0, dot), '•', ...production.right.slice(dot)];
  return `${production.left} → ${body.join(' ')} (${origin})`;
}

/* ------------------------------------------------------------------------ */
/* Precondition checks                                                       */
/* ------------------------------------------------------------------------ */

function assertRunnable(grammar, input) {
  // The precedent for validating here is convertToCnf, not runCyk. CYK never
  // re-validates because it only ever receives a grammar that already passed
  // through the converter; runEarley takes the user's ORIGINAL grammar and is
  // reachable directly, so it guards itself. A safety net, not a UI path —
  // and it is what lets everything below assume every right-hand-side symbol
  // is a declared variable or a declared terminal.
  const validation = validateGrammar(grammar);
  if (!validation.valid) {
    throw new EarleyError(
      'GRAMMAR_INVALID',
      'Earley parses any context-free grammar, but the grammar must be well formed — ' +
        `${validation.errors[0].message}`
    );
  }
  if (typeof input !== 'string') {
    throw new EarleyError('INVALID_INPUT', 'The input must be a string.');
  }
  if (input.length > MAX_INPUT_LENGTH) {
    throw new EarleyError(
      'INPUT_TOO_LONG',
      `The input has ${input.length} characters — the simulator supports at most ` +
        `${MAX_INPUT_LENGTH} (the chart must stay readable).`
    );
  }
  const terminals = new Set(grammar.terminals);
  for (let position = 0; position < input.length; position += 1) {
    if (!terminals.has(input[position])) {
      throw new EarleyError(
        'INVALID_INPUT_CHAR',
        `Character "${input[position]}" at position ${position + 1} is not in the grammar's ` +
          `alphabet Σ = { ${grammar.terminals.join(', ')} }.`
      );
    }
  }
}

/**
 * Two derivations describe the same route iff every pointer agrees.
 *
 * Only completions ever reach this in practice: a scanned item lands in the
 * next column with a dot that no predict (dot 0) and no completion (which
 * needs a variable before the dot, where a scan needs a terminal) can also
 * produce, so it is always new. The `child` guards keep the comparison total
 * rather than guarding against a collision that can happen.
 */
function sameDerivation(a, b) {
  return (
    a.type === b.type &&
    a.back.column === b.back.column &&
    a.back.index === b.back.index &&
    (a.child?.column ?? -1) === (b.child?.column ?? -1) &&
    (a.child?.index ?? -1) === (b.child?.index ?? -1)
  );
}

/* ------------------------------------------------------------------------ */
/* The algorithm                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Run Earley.
 *
 * @param {object} grammar Any valid CFG — NOT required to be in CNF.
 * @param {string} input   The string to test (characters must all be in Σ).
 * @returns {{
 *   accepted: boolean, input: string, n: number, startSymbol: string,
 *   chart: Array<{index: number, items: object[]}>,   // chart[c], c = 0..n
 *   steps: object[]  // the animation trace, ending with a 'verdict' step
 * }}
 * @throws {EarleyError} GRAMMAR_INVALID | INVALID_INPUT | INPUT_TOO_LONG |
 *                       INVALID_INPUT_CHAR
 */
export function runEarley(grammar, input) {
  assertRunnable(grammar, input);

  const n = input.length;
  const start = grammar.startSymbol;
  const steps = [];
  const variables = new Set(grammar.variables);

  /** The input as it reads in prose: ε for the empty string. */
  const shownInput = n === 0 ? 'ε' : `"${input}"`;
  /** How a span of the input reads in prose: ε when it is empty. */
  const spanText = (from, to) => (from === to ? 'ε' : `"${input.slice(from, to)}"`);

  /** variable → its productions, in declaration order. */
  const rulesFor = new Map();
  for (const production of grammar.productions) {
    if (!rulesFor.has(production.left)) rulesFor.set(production.left, []);
    rulesFor.get(production.left).push(production);
  }

  /* ——— The chart ————————————————————————————————————————————— */
  // chart[c] holds every item whose dot sits just before input position c.
  //
  // Item shape (plain JSON so the result can travel over the REST API and be
  // consumed by core/earley-tree.js unchanged):
  //
  //   item = { production,       // a production of the ORIGINAL grammar
  //            dot,              // 0 .. production.right.length
  //            origin,           // the column this item was predicted in
  //            derivations: [] } // how the dot reached its position
  //
  //   derivation = { type: 'scan',     back }         // a terminal was read
  //              | { type: 'complete', back, child }  // a variable finished
  //
  //   `back`  = {column, index} of the SAME production one dot earlier,
  //   `child` = {column, index} of the completed item that was consumed.
  //   Items with dot = 0 were predicted (or seeded) and have no derivations.
  //
  // ALL derivations are kept (not just the first) — that is what preserves
  // ambiguity information and gives the tree builder its backpointers.
  const chart = [];
  for (let c = 0; c <= n; c += 1) {
    chart[c] = { index: c, items: [] };
  }

  /** Per column: item key → its index, so an item is never duplicated. */
  const seen = chart.map(() => new Map());

  /**
   * Per column: variable → indices of the items completed IN THIS COLUMN
   * whose origin IS this column — precisely the ε-completions. Read by
   * repairNullable() below; this is half of the ε fix.
   */
  const completedHere = chart.map(() => new Map());

  /**
   * Insert an item into column `c`, or merge a new derivation into the
   * matching item already there.
   *
   * @param {number} c          the target column.
   * @param {object} production a production of the original grammar.
   * @param {number} dot        how many right-hand-side symbols have matched.
   * @param {number} origin     the column this production started in.
   * @param {object|null} derivation how the dot got here (null when dot = 0).
   * @returns {{index: number, isNew: boolean}}
   */
  const addItem = (c, production, dot, origin, derivation = null) => {
    const key = `${productionKey(production)}\u001f${dot}\u001f${origin}`;
    const existing = seen[c].get(key);

    if (existing === undefined) {
      const index = chart[c].items.length;
      chart[c].items.push({
        production,
        dot,
        origin,
        derivations: derivation ? [derivation] : [],
      });
      seen[c].set(key, index);
      return { index, isNew: true };
    }

    // The item is already here. Record the derivation only if this exact
    // route was not taken before: the two ε mechanisms below can reach the
    // same (waiting item, completion) pair from either side, and a duplicate
    // route would fake ambiguity that the grammar does not have.
    const item = chart[c].items[existing];
    if (derivation && !item.derivations.some((d) => sameDerivation(d, derivation))) {
      item.derivations.push(derivation);
    }
    return { index: existing, isNew: false };
  };

  /**
   * PREDICT — the dot sits before variable `symbol`, so any rule of `symbol`
   * could start at this column: add each with the dot at the front.
   */
  const predict = (c, idx, symbol) => {
    const item = chart[c].items[idx];
    const added = [];

    for (const production of rulesFor.get(symbol) ?? []) {
      const { index, isNew } = addItem(c, production, 0, c);
      if (isNew) added.push(index);
    }

    steps.push({
      type: 'predict',
      column: c,
      index: idx,
      symbol,
      added,
      explanation:
        `${itemToString(item)}: the dot is before ${symbol}, so a ${symbol} must begin at ` +
        `column ${c}. ` +
        (added.length > 0
          ? `Predicted ${added.map((i) => itemToString(chart[c].items[i])).join(', ')}.`
          : `Every ${symbol}-rule is already in column ${c} — nothing new to predict.`),
    });

    repairNullable(c, idx, symbol);
  };

  /**
   * The ε repair — the subtle half of the Aycock–Horspool problem.
   *
   * `symbol` may ALREADY have been completed in this very column with this
   * column as its origin: it derived ε here. That completer scanned the
   * column and finished before the item at `idx` existed, and it will never
   * run again — re-predicting `symbol` above produced only duplicates. So the
   * dot has to be moved over `symbol` from this side instead.
   *
   * Together with the live-length scan in complete(), this covers every
   * (waiting item, ε-completion) pair within a column: whichever of the two
   * entered the column SECOND performs the pairing. Without it, valid parses
   * are silently lost — see docs/algorithms.md §6.
   */
  const repairNullable = (c, idx, symbol) => {
    const completions = completedHere[c].get(symbol) ?? [];
    if (completions.length === 0) return;

    const item = chart[c].items[idx];
    const advanced = [];

    for (const childIndex of completions) {
      const { index } = addItem(c, item.production, item.dot + 1, item.origin, {
        type: 'complete',
        back: { column: c, index: idx },
        child: { column: c, index: childIndex },
      });
      advanced.push({ column: c, index });
    }

    steps.push({
      type: 'complete',
      column: c,
      index: idx,
      symbol,
      origin: c,
      advanced,
      nullableRepair: true,
      explanation:
        `${symbol} already derived ε in column ${c}, and that completion ran before ` +
        `${itemToString(item)} was added — so the dot moves over ${symbol} here instead. ` +
        `Advanced ${advanced
          .map((a) => itemToString(chart[a.column].items[a.index]))
          .join(', ')}.`,
    });
  };

  /**
   * SCAN — the dot sits before a terminal. If it is the next input
   * character the item moves into the NEXT column with the dot advanced;
   * nothing else in the algorithm consumes input.
   */
  const scan = (c, idx, terminal) => {
    const item = chart[c].items[idx];
    const matched = c < n && input[c] === terminal;
    let target = null;

    if (matched) {
      const { index } = addItem(c + 1, item.production, item.dot + 1, item.origin, {
        type: 'scan',
        back: { column: c, index: idx },
      });
      target = index;
    }

    steps.push({
      type: 'scan',
      column: c,
      index: idx,
      terminal,
      matched,
      target,
      explanation:
        `${itemToString(item)}: the dot is before the terminal "${terminal}". ` +
        (matched
          ? `w[${c + 1}] = "${terminal}" matches, so the item moves into column ${c + 1} as ` +
            `${itemToString(chart[c + 1].items[target])}.`
          : c < n
            ? `w[${c + 1}] = "${input[c]}" does not match, so this item is dead.`
            : 'The input is exhausted, so nothing can match and this item is dead.'),
    });
  };

  /**
   * COMPLETE — the dot has reached the end of A → γ •, a production that
   * began in column `origin`. Every item waiting for an A back at that
   * column can now move its dot over the A.
   */
  const complete = (c, idx) => {
    const item = chart[c].items[idx];
    const symbol = item.production.left;
    const j = item.origin;
    const advanced = [];

    // Register ε-completions BEFORE scanning, so that an item predicted
    // later in this same column can still find this completion.
    if (j === c) {
      if (!completedHere[c].has(symbol)) completedHere[c].set(symbol, []);
      completedHere[c].get(symbol).push(idx);
    }

    // The bound is re-read on every iteration, so that when j === c this
    // scan also picks up the items it appends while it is running. That
    // alone does NOT make ε safe: an item waiting for A can still be
    // predicted after this scan has finished, which is what repairNullable()
    // handles. Between them every (waiting item, completion) pair in a
    // column is matched — whichever of the two arrived second makes the
    // match — and that is the property the ε tests pin down.
    for (let w = 0; w < chart[j].items.length; w += 1) {
      const waiting = chart[j].items[w];
      if (waiting.production.right[waiting.dot] !== symbol) continue;

      const { index } = addItem(c, waiting.production, waiting.dot + 1, waiting.origin, {
        type: 'complete',
        back: { column: j, index: w },
        child: { column: c, index: idx },
      });
      advanced.push({ column: c, index });
    }

    steps.push({
      type: 'complete',
      column: c,
      index: idx,
      symbol,
      origin: j,
      advanced,
      explanation:
        `${itemToString(item)} is complete: ${symbol} derives ${spanText(j, c)}. Every item in ` +
        `column ${j} whose dot is before ${symbol} can advance. ` +
        (advanced.length > 0
          ? `Advanced ${advanced
              .map((a) => itemToString(chart[a.column].items[a.index]))
              .join(', ')}.`
          : `No item in column ${j} was waiting for ${symbol}.`),
    });
  };

  /* ——— Seed column 0 with the start symbol's rules ————————————— */
  for (const production of rulesFor.get(start) ?? []) {
    addItem(0, production, 0, 0);
  }

  steps.push({
    type: 'begin',
    explanation:
      `Earley builds ${n + 1} columns for w = ${shownInput} (n = ${n}). An item A → α • β (j) ` +
      'in column c means: a production of A began at column j, and α has matched the input ' +
      `between columns j and c. Column 0 is seeded with ` +
      `${(rulesFor.get(start) ?? []).map(productionToString).join(', ') || '∅'}, dotted at the ` +
      'front. No Chomsky Normal Form conversion is needed.',
  });

  /* ——— Fill the columns left to right ————————————————————————— */
  for (let c = 0; c <= n; c += 1) {
    const column = chart[c];

    // The bound is re-read every iteration: predict, complete and the ε
    // repair all append to the very column being scanned, and those new
    // items must be processed too. This loop is a work-list, not a pass over
    // a fixed-size array.
    for (let idx = 0; idx < column.items.length; idx += 1) {
      const item = column.items[idx];
      const next = item.production.right[item.dot];

      if (next === undefined) {
        complete(c, idx);
      } else if (variables.has(next)) {
        predict(c, idx, next);
      } else {
        scan(c, idx, next);
      }
    }

    steps.push({
      type: 'column-done',
      column: c,
      size: column.items.length,
      explanation:
        `Column ${c} is closed with ${column.items.length} item` +
        `${column.items.length === 1 ? '' : 's'}` +
        (c < n ? `. Next the parser reads w[${c + 1}] = "${input[c]}".` : ' — the input ends here.'),
    });
  }

  /* ——— Verdict ——————————————————————————————————————————————— */
  // Acceptance needs no special case for the empty string: with n = 0 the
  // chart is the single column 0, and a rule S → ε is seeded there as the
  // already-complete item S → • (0), which this test finds like any other.
  const accepting = chart[n].items.filter(
    (item) =>
      item.production.left === start &&
      item.origin === 0 &&
      item.dot === item.production.right.length
  );
  const accepted = accepting.length > 0;

  steps.push({
    type: 'verdict',
    accepted,
    explanation: accepted
      ? `Column ${n} contains ${itemToString(accepting[0])} — a completed ${start}-rule that ` +
        `began at column 0, so ${start} derives the whole input: ${shownInput} ∈ L(G) — ACCEPTED.`
      : `Column ${n} contains no completed ${start}-rule with origin 0, so ${start} cannot ` +
        `derive the whole input: ${shownInput} ∉ L(G) — REJECTED.`,
  });

  return { accepted, input, n, startSymbol: start, chart, steps };
}
