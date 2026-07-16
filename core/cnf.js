/**
 * core/cnf.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Conversion of an arbitrary (valid) context-free grammar into Chomsky
 *   Normal Form, recording every transformation step with an explanation
 *   so the UI can teach the algorithm, not just apply it.
 *
 *   Pipeline (see docs/algorithms.md §3 for the full theory):
 *
 *       START → TERM → BIN → DEL → UNIT → CLEANUP
 *
 *   The order is essential: BIN before DEL keeps the ε-elimination
 *   polynomial (right-hand sides have length ≤ 2, so at most 4 variants
 *   per rule), and UNIT runs last because DEL creates new unit rules.
 *
 *   Every stage is a PURE function grammar → {grammar, changes, explanation}
 *   (exported individually for unit testing); convertToCnf composes them.
 *
 *   Pure ES module — shared verbatim by the browser, the server and Jest.
 */

import { cloneGrammar, productionKey, productionToString } from './grammar.js';
import { validateGrammar, computeGenerating, computeReachable } from './validator.js';

/* ------------------------------------------------------------------------ */
/* Change-entry helpers (what the UI renders per step)                       */
/* ------------------------------------------------------------------------ */

/**
 * Every stage reports its work as a list of typed CHANGE ENTRIES. This is
 * the data structure the CNF view renders (green +, red −, before ⇒ after):
 *
 *   { type: 'add',     production: {left, right}, reason: string }
 *   { type: 'remove',  production: {left, right}, reason: string }
 *   { type: 'replace', before: {left, right}, after: {left, right}, reason }
 *
 * `reason` is a complete, student-facing sentence explaining WHY the rule
 * was added/removed — the explanations in the UI come straight from here.
 */
const added = (production, reason) => ({ type: 'add', production, reason });
const removed = (production, reason) => ({ type: 'remove', production, reason });
const replaced = (before, after, reason) => ({ type: 'replace', before, after, reason });

/** Compact display form used inside `reason` strings. */
const show = productionToString;

/* ------------------------------------------------------------------------ */
/* Fresh-name generation                                                     */
/* ------------------------------------------------------------------------ */

/**
 * A namer that can never collide with existing variables: it records every
 * name it has seen or produced and appends counters until a name is free.
 */
function makeNamer(grammar) {
  const used = new Set(grammar.variables);
  const counters = new Map();
  return {
    /** Claim `base` if free, otherwise base1, base2, ... */
    fresh(base) {
      let candidate = base;
      let counter = 0;
      while (used.has(candidate)) {
        counter += 1;
        candidate = `${base}${counter}`;
      }
      used.add(candidate);
      return candidate;
    },
    /** Sequential names prefix1, prefix2, ... skipping anything taken. */
    seq(prefix) {
      let n = counters.get(prefix) ?? 0;
      let candidate;
      do {
        n += 1;
        candidate = `${prefix}${n}`;
      } while (used.has(candidate));
      counters.set(prefix, n);
      used.add(candidate);
      return candidate;
    },
    /**
     * A readable variable for terminal `t`: T_a for alphanumeric terminals,
     * T1, T2, ... for symbols like '(' that cannot appear in a name.
     */
    freshForTerminal(t) {
      return /^[A-Za-z0-9]$/.test(t) ? this.fresh(`T_${t}`) : this.seq('T');
    },
  };
}

/* ------------------------------------------------------------------------ */
/* CNF predicate                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Is the grammar already in Chomsky Normal Form?
 *   A → B C   (two variables) |  A → a  (one terminal) |
 *   S → ε     (start only, and S must not occur on any right-hand side)
 */
export function isCnf(grammar) {
  const variables = new Set(grammar.variables);
  const terminals = new Set(grammar.terminals);
  const startOnRhs = grammar.productions.some((p) => p.right.includes(grammar.startSymbol));

  return grammar.productions.every((production) => {
    const { left, right } = production;
    if (right.length === 0) {
      return left === grammar.startSymbol && !startOnRhs;
    }
    if (right.length === 1) {
      return terminals.has(right[0]);
    }
    if (right.length === 2) {
      return variables.has(right[0]) && variables.has(right[1]);
    }
    return false;
  });
}

/* ------------------------------------------------------------------------ */
/* Stage 1 — START: fresh start symbol                                       */
/* ------------------------------------------------------------------------ */

/**
 * STAGE 1 (START): introduce a fresh start symbol S0 → S if — and only if —
 * the current start symbol appears on some right-hand side.
 *
 * Why: CNF permits a single ε-rule, S → ε, but only when the start symbol
 * never occurs on a right-hand side; otherwise a derivation could duplicate
 * the start symbol mid-string and "erase" parts of it through ε. Adding S0
 * up front makes the later DEL stage's `S0 → ε` unconditionally safe.
 * When the start symbol is already absent from every RHS, the stage is a
 * documented no-op (the returned explanation says why nothing changed).
 *
 * @param {object} grammar A valid grammar (not mutated — a clone is edited).
 * @returns {{grammar: object, changes: object[], explanation: string}}
 */
export function applyStart(grammar) {
  const result = cloneGrammar(grammar);
  const changes = [];

  const startOnRhs = grammar.productions.some((p) => p.right.includes(grammar.startSymbol));
  if (!startOnRhs) {
    return {
      grammar: result,
      changes,
      explanation:
        `The start symbol ${grammar.startSymbol} never appears on a right-hand side, ` +
        'so no new start symbol is needed.',
    };
  }

  const namer = makeNamer(result);
  const newStart = namer.fresh(`${grammar.startSymbol}0`);
  const rule = { left: newStart, right: [grammar.startSymbol] };

  result.variables = [newStart, ...result.variables];
  result.productions = [rule, ...result.productions];
  result.startSymbol = newStart;

  changes.push(
    added(
      rule,
      `${grammar.startSymbol} appears on a right-hand side, so a fresh start symbol ` +
        `${newStart} is introduced. This makes it safe to add ${newStart} → ε later if ε ∈ L.`
    )
  );

  return {
    grammar: result,
    changes,
    explanation:
      `A new start symbol ${newStart} with the single rule ${show(rule)} guarantees ` +
      'that the start symbol never occurs on a right-hand side.',
  };
}

/* ------------------------------------------------------------------------ */
/* Stage 2 — TERM: isolate terminals in long right-hand sides                */
/* ------------------------------------------------------------------------ */

/**
 * STAGE 2 (TERM): in every right-hand side of length ≥ 2, replace each
 * terminal `a` by a fresh variable T_a and add the rule T_a → a.
 *
 * Why: CNF only allows terminals in rules of the exact shape A → a. Rules
 * of length 1 are already that shape, so they are left untouched — only
 * "mixed" rules like S → a S b violate the form. One replacement variable
 * is created PER TERMINAL and reused across all rules (the `replacementFor`
 * map), so the grammar grows by at most |Σ| extra variables.
 *
 * @param {object} grammar A valid grammar (not mutated — a clone is edited).
 * @returns {{grammar: object, changes: object[], explanation: string}}
 */
export function applyTerm(grammar) {
  const result = cloneGrammar(grammar);
  const changes = [];
  const terminals = new Set(result.terminals);
  const namer = makeNamer(result);

  /** terminal → its replacement variable (shared across all rules). */
  const replacementFor = new Map();
  const newRules = [];

  result.productions = result.productions.map((production) => {
    if (production.right.length < 2) return production;
    if (!production.right.some((symbol) => terminals.has(symbol))) return production;

    const before = { ...production, right: [...production.right] };
    const right = production.right.map((symbol) => {
      if (!terminals.has(symbol)) return symbol;

      if (!replacementFor.has(symbol)) {
        const variable = namer.freshForTerminal(symbol);
        replacementFor.set(symbol, variable);
        const rule = { left: variable, right: [symbol] };
        newRules.push(rule);
        result.variables.push(variable);
        changes.push(
          added(rule, `${variable} stands for the terminal "${symbol}" inside longer rules.`)
        );
      }
      return replacementFor.get(symbol);
    });

    const after = { left: production.left, right };
    changes.push(
      replaced(
        before,
        after,
        `Terminals inside a right-hand side of length ≥ 2 are replaced by their new variables.`
      )
    );
    return after;
  });

  result.productions.push(...newRules);

  return {
    grammar: result,
    changes,
    explanation:
      changes.length === 0
        ? 'No rule of length ≥ 2 contains a terminal — nothing to do.'
        : 'After TERM, terminals appear only in rules of the exact CNF form A → a.',
  };
}

/* ------------------------------------------------------------------------ */
/* Stage 3 — BIN: binarize long right-hand sides                             */
/* ------------------------------------------------------------------------ */

/**
 * STAGE 3 (BIN): replace every rule A → X1 X2 … Xk with k ≥ 3 by a cascade
 * of binary rules threaded through fresh variables:
 *
 *     A → X1 N1,  N1 → X2 N2,  …,  N(k−2) → X(k−1) Xk
 *
 * Why here in the pipeline: running BIN BEFORE DEL is the complexity
 * argument of the whole conversion. DEL must enumerate every subset of
 * nullable symbols in a right-hand side (2^k variants); after BIN, k ≤ 2,
 * so that enumeration is bounded by 4 variants per rule instead of being
 * exponential in the longest right-hand side.
 *
 * Fresh cascade variables are NOT shared between rules — sharing would
 * accidentally merge derivations of unrelated rules.
 *
 * @param {object} grammar A valid grammar, ideally after TERM (not mutated).
 * @returns {{grammar: object, changes: object[], explanation: string}}
 */
export function applyBin(grammar) {
  const result = cloneGrammar(grammar);
  const changes = [];
  const namer = makeNamer(result);
  const rewritten = [];

  for (const production of result.productions) {
    if (production.right.length <= 2) {
      rewritten.push(production);
      continue;
    }

    // A → X1 X2 ... Xk   becomes   A → X1 N1, N1 → X2 N2, ..., N(k-2) → X(k-1) Xk
    const before = { ...production, right: [...production.right] };
    const symbols = production.right;
    let carrierLeft = production.left;
    const cascade = [];

    for (let i = 0; i < symbols.length - 2; i += 1) {
      const nextVariable = namer.seq('X');
      cascade.push({ left: carrierLeft, right: [symbols[i], nextVariable] });
      result.variables.push(nextVariable);
      carrierLeft = nextVariable;
    }
    cascade.push({ left: carrierLeft, right: symbols.slice(-2) });

    changes.push(
      replaced(
        before,
        cascade[0],
        `${show(before)} has ${symbols.length} symbols — it is split into a cascade of ` +
          `${cascade.length} binary rules: ${cascade.map(show).join(' ,  ')}.`
      )
    );
    for (const rule of cascade.slice(1)) {
      changes.push(added(rule, 'Continuation of the cascade above.'));
    }
    rewritten.push(...cascade);
  }

  result.productions = rewritten;

  return {
    grammar: result,
    changes,
    explanation:
      changes.length === 0
        ? 'Every right-hand side already has length ≤ 2 — nothing to do.'
        : 'After BIN, every right-hand side has at most two symbols. ' +
          'Doing this BEFORE ε-elimination is what keeps the whole conversion polynomial.',
  };
}

/* ------------------------------------------------------------------------ */
/* Stage 4 — DEL: eliminate ε-productions                                    */
/* ------------------------------------------------------------------------ */

/**
 * The NULLABLE set: every variable A with A ⇒* ε.
 *
 * Bottom-up fixpoint: A is nullable iff some rule A → α exists where every
 * symbol of α is a nullable variable. ε-rules (right = []) are the base
 * case — `every` over an empty array is vacuously true.
 *
 * Termination/invariant: `nullable` only ever GROWS and is bounded by |V|,
 * so the outer while-loop runs at most |V| + 1 passes; a pass that adds
 * nothing proves the set is complete (a fixpoint has been reached).
 *
 * @param {object} grammar Any grammar (terminals in α disqualify a rule
 *                         automatically, since only variables can be nullable).
 * @returns {Set<string>} the nullable variables.
 */
export function computeNullable(grammar) {
  const variables = new Set(grammar.variables);
  const nullable = new Set();

  let changed = true;
  while (changed) {
    changed = false;
    for (const production of grammar.productions) {
      if (nullable.has(production.left)) continue;
      const allNullable = production.right.every(
        (symbol) => variables.has(symbol) && nullable.has(symbol)
      );
      if (allNullable) {
        nullable.add(production.left); // includes ε-rules: right = [] is trivially all-nullable
        changed = true;
      }
    }
  }
  return nullable;
}

/**
 * STAGE 4 (DEL): eliminate ε-productions.
 *
 * For every rule, every SUBSET of its nullable-symbol occurrences may be
 * omitted (each omitted occurrence stands for "that variable derived ε"),
 * producing new variant rules; then all ε-productions are dropped. If the
 * start symbol itself was nullable, exactly one ε-rule is re-added for it —
 * the single ε-production CNF permits (safe because START guaranteed the
 * start symbol is on no right-hand side).
 *
 * Precondition (for the complexity bound, not for correctness): TERM and
 * BIN have run, so every right-hand side has ≤ 2 symbols and the subset
 * enumeration below is capped at 4 variants per rule.
 *
 * @param {object} grammar A valid grammar after TERM+BIN (not mutated).
 * @returns {{grammar: object, changes: object[], explanation: string}}
 */
export function applyDel(grammar) {
  const result = cloneGrammar(grammar);
  const changes = [];
  const nullable = computeNullable(result);

  const keptKeys = new Set();
  const kept = [];

  // Deduplicating collector: two different subset-omissions can produce the
  // SAME variant (e.g. S → A A with nullable A yields "S → A" twice — once
  // per omitted position). productionKey makes the second copy a no-op, so
  // the classic duplicate-variant bug cannot occur.
  const keep = (production, reason) => {
    const key = productionKey(production);
    if (keptKeys.has(key)) return;
    keptKeys.add(key);
    kept.push(production);
    if (reason) changes.push(added(production, reason));
  };

  for (const production of result.productions) {
    if (production.right.length === 0) {
      changes.push(
        removed(production, `ε-productions are eliminated; ${production.left} is nullable.`)
      );
      continue;
    }

    // Original rule (the ∅ subset) survives as-is.
    keep(production, null);

    // Every subset of nullable occurrences may be omitted. After BIN the
    // right-hand side has ≤ 2 symbols, so this loop enumerates ≤ 4 subsets.
    const positions = production.right
      .map((symbol, index) => (nullable.has(symbol) ? index : -1))
      .filter((index) => index !== -1);

    // Bitmask enumeration of the non-empty subsets of nullable positions:
    // bit b of `mask` set ⇔ omit positions[b]. `mask` starts at 1 because
    // the ∅ subset (omit nothing) is the original rule, already kept above.
    for (let mask = 1; mask < 1 << positions.length; mask += 1) {
      const omit = new Set(positions.filter((_, bit) => mask & (1 << bit)));
      const right = production.right.filter((_, index) => !omit.has(index));
      if (right.length === 0) continue; // ε variants are exactly what we are removing
      keep(
        { left: production.left, right },
        `Derived from ${show(production)} by omitting nullable ` +
          `${omit.size === 1 ? 'symbol' : 'symbols'} ` +
          `${[...omit].map((i) => production.right[i]).join(', ')} (each can derive ε).`
      );
    }
  }

  // ε ∈ L(G) iff the start symbol is nullable — keep exactly one ε-rule for it.
  if (nullable.has(result.startSymbol)) {
    const epsilonRule = { left: result.startSymbol, right: [] };
    if (!keptKeys.has(productionKey(epsilonRule))) {
      kept.push(epsilonRule);
      keptKeys.add(productionKey(epsilonRule));
      changes.push(
        added(
          epsilonRule,
          `ε belongs to the language, so the start symbol keeps a single ε-rule — ` +
            'the one ε-production CNF permits.'
        )
      );
    }
  }

  result.productions = kept;

  return {
    grammar: result,
    changes,
    explanation:
      changes.length === 0
        ? 'The grammar has no ε-productions — nothing to do.'
        : `Nullable variables: { ${[...nullable].join(', ') || '—'} }. Every rule gains variants ` +
          'with nullable symbols omitted, and all ε-productions disappear' +
          (nullable.has(result.startSymbol) ? ' (except the start symbol’s, since ε ∈ L).' : '.'),
  };
}

/* ------------------------------------------------------------------------ */
/* Stage 5 — UNIT: eliminate unit productions                                */
/* ------------------------------------------------------------------------ */

/**
 * STAGE 5 (UNIT): eliminate unit productions (rules A → B with B a variable).
 *
 * Method: compute the UNIT-PAIR CLOSURE — for every A, the set of variables
 * B with A ⇒* B using only unit rules — then let A adopt every NON-unit rule
 * of every B it reaches, and delete all unit rules. Computing reachability
 * first (instead of repeatedly rewriting A → B → C …) is what makes unit
 * CYCLES (A → B, B → A) terminate trivially: a closure is a set, and sets
 * don't loop.
 *
 * Why this stage runs LAST: DEL creates new unit rules (A → B C with C
 * nullable leaves the variant A → B), so eliminating units any earlier
 * would have to be redone.
 *
 * Note: the adopted rules are already CNF-shaped (length-2 variable pairs,
 * length-1 terminals, or the start's ε-rule) because TERM/BIN/DEL ran first —
 * UNIT cannot reintroduce any earlier stage's violation.
 *
 * @param {object} grammar A valid grammar after DEL (not mutated).
 * @returns {{grammar: object, changes: object[], explanation: string}}
 */
export function applyUnit(grammar) {
  const result = cloneGrammar(grammar);
  const changes = [];
  const variables = new Set(result.variables);

  const isUnit = (production) =>
    production.right.length === 1 && variables.has(production.right[0]);

  if (!result.productions.some(isUnit)) {
    return { grammar: result, changes, explanation: 'The grammar has no unit productions — nothing to do.' };
  }

  /**
   * Unit-pair closure: unitReach.get(A) = every B with A ⇒* B via unit
   * rules only (computed as a small BFS per variable — handles cycles).
   */
  const unitReach = new Map();
  for (const variable of result.variables) {
    const reached = new Set([variable]);
    const queue = [variable];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const production of result.productions) {
        if (production.left !== current || !isUnit(production)) continue;
        const target = production.right[0];
        if (!reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }
    unitReach.set(variable, reached);
  }

  const newProductions = [];
  const seen = new Set();

  for (const variable of result.variables) {
    for (const target of unitReach.get(variable)) {
      for (const production of result.productions) {
        if (production.left !== target || isUnit(production)) continue;
        const pulled = { left: variable, right: [...production.right] };
        const key = productionKey(pulled);
        if (seen.has(key)) continue;
        seen.add(key);
        newProductions.push(pulled);
        if (variable !== target) {
          changes.push(
            added(
              pulled,
              `${variable} ⇒* ${target} through unit rules, so ${variable} takes over ` +
                `the non-unit rule ${show(production)} directly.`
            )
          );
        }
      }
    }
  }

  for (const production of result.productions) {
    if (isUnit(production)) {
      changes.push(removed(production, 'Unit productions are eliminated.'));
    }
  }

  result.productions = newProductions;

  return {
    grammar: result,
    changes,
    explanation:
      'Every chain A ⇒* B of unit rules is collapsed: A copies B’s non-unit rules and the ' +
      'unit rules themselves are removed. (Unit cycles are safe — the closure is a reachability set.)',
  };
}

/* ------------------------------------------------------------------------ */
/* Stage 6 — CLEANUP: remove useless symbols                                 */
/* ------------------------------------------------------------------------ */

/**
 * STAGE 6 (CLEANUP): remove useless symbols, reusing the validator's two
 * fixpoint analyses (single source of truth for both diagnosis and repair).
 *
 * Pass order is essential and classic (Hopcroft & Ullman):
 *   1. drop NON-GENERATING variables first (they can never finish a
 *      derivation, so every rule touching them is dead), THEN
 *   2. drop UNREACHABLE variables — because removing dead-end rules in
 *      pass 1 can disconnect further variables from the start symbol.
 * Running the passes in the opposite order can leave useless symbols behind.
 *
 * The start symbol is always kept (a grammar needs one even when L(G) = ∅),
 * and the terminal alphabet Σ is deliberately left unchanged: Σ is part of
 * the language's definition, and pruning it would turn honest "rejected"
 * CYK answers into misleading "not in alphabet" errors.
 *
 * @param {object} grammar A valid grammar (not mutated — a clone is edited).
 * @returns {{grammar: object, changes: object[], explanation: string}}
 */
export function removeUseless(grammar) {
  const result = cloneGrammar(grammar);
  const changes = [];

  // Pass 1: drop non-generating variables (and rules mentioning them).
  const generating = computeGenerating(result);
  const nonGenerating = result.variables.filter((v) => !generating.has(v));

  if (nonGenerating.length > 0) {
    const doomed = new Set(nonGenerating);
    for (const production of result.productions) {
      if (doomed.has(production.left) || production.right.some((s) => doomed.has(s))) {
        changes.push(
          removed(
            production,
            `Removed because { ${nonGenerating.join(', ')} } can never derive a terminal string.`
          )
        );
      }
    }
    result.productions = result.productions.filter(
      (p) => !doomed.has(p.left) && !p.right.some((s) => doomed.has(s))
    );
    result.variables = result.variables.filter((v) => !doomed.has(v) || v === result.startSymbol);
  }

  // Pass 2: drop unreachable variables (order matters — do this second).
  const reachable = computeReachable(result);
  const unreachable = result.variables.filter(
    (v) => !reachable.has(v) && v !== result.startSymbol
  );

  if (unreachable.length > 0) {
    const doomed = new Set(unreachable);
    for (const production of result.productions) {
      if (doomed.has(production.left)) {
        changes.push(
          removed(
            production,
            `Removed because { ${unreachable.join(', ')} } is unreachable from the start symbol.`
          )
        );
      }
    }
    result.productions = result.productions.filter((p) => !doomed.has(p.left));
    result.variables = result.variables.filter((v) => !doomed.has(v));
  }

  return {
    grammar: result,
    changes,
    explanation:
      changes.length === 0
        ? 'Every variable is generating and reachable — nothing to clean up.'
        : 'Non-generating variables are removed first, then unreachable ones — removing dead ' +
          'ends can cut off further variables. The terminal alphabet Σ stays unchanged.',
  };
}

/* ------------------------------------------------------------------------ */
/* The full pipeline                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The pipeline as data: each entry is {key, title, apply} where `apply` is
 * one of the pure stage functions above. convertToCnf folds the grammar
 * through this list in order — the array IS the algorithm's structure, and
 * its order encodes the correctness/complexity argument documented per stage.
 */
const STAGES = [
  { key: 'START', title: 'START — new start symbol', apply: applyStart },
  { key: 'TERM', title: 'TERM — isolate terminals', apply: applyTerm },
  { key: 'BIN', title: 'BIN — binarize long rules', apply: applyBin },
  { key: 'DEL', title: 'DEL — eliminate ε-productions', apply: applyDel },
  { key: 'UNIT', title: 'UNIT — eliminate unit productions', apply: applyUnit },
  { key: 'CLEANUP', title: 'CLEANUP — remove useless symbols', apply: removeUseless },
];

/**
 * Convert a VALID grammar to Chomsky Normal Form.
 *
 * Behaviour notes:
 *  - A grammar that is already CNF short-circuits into a single explanatory
 *    "DONE" step (running the pipeline anyway would add-and-remove a
 *    pointless S0 and confuse the step display).
 *  - Each step records a DEEP SNAPSHOT of the grammar after its stage, so
 *    the UI can show every intermediate grammar without recomputation.
 *  - `emptyLanguage` is decided AFTER cleanup: if the start symbol ends up
 *    with no productions, every rule was a dead end and L(G) = ∅.
 *
 * @param {object} grammar The source grammar (never mutated).
 * @throws {Error} if the grammar does not pass the shared validator —
 *                 callers (editor, API service) validate first and show
 *                 the findings; this guard is a safety net, not a UI path.
 * @returns {{original: object, alreadyCnf: boolean,
 *            steps: {stage,title,explanation,changes,grammar}[],
 *            result: object, emptyLanguage: boolean}}
 */
export function convertToCnf(grammar) {
  const validation = validateGrammar(grammar);
  if (!validation.valid) {
    throw new Error('Only a valid grammar can be converted to CNF — fix the validation errors first.');
  }

  const original = cloneGrammar(grammar);

  if (isCnf(original)) {
    return {
      original,
      alreadyCnf: true,
      steps: [
        {
          stage: 'DONE',
          title: 'Already in Chomsky Normal Form',
          explanation:
            'Every production already has the form A → B C, A → a, or the permitted S → ε — ' +
            'no transformation is necessary.',
          changes: [],
          grammar: cloneGrammar(original),
        },
      ],
      result: cloneGrammar(original),
      emptyLanguage: false,
    };
  }

  const steps = [];
  let current = original;

  for (const stage of STAGES) {
    const { grammar: next, changes, explanation } = stage.apply(current);
    steps.push({
      stage: stage.key,
      title: stage.title,
      explanation,
      changes,
      grammar: cloneGrammar(next),
    });
    current = next;
  }

  const emptyLanguage = !current.productions.some((p) => p.left === current.startSymbol);

  return {
    original,
    alreadyCnf: false,
    steps,
    result: current,
    emptyLanguage,
  };
}
