/**
 * public/js/engines.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The one place that knows how to run a string through a parser engine.
 *
 *   CFG Studio ships two independent engines that decide the SAME language:
 *
 *     Earley  parses the user's grammar directly, needs no conversion, and
 *             produces a parse tree labelled with the user's own symbols.
 *     CYK     needs Chomsky Normal Form first, and produces a tree labelled
 *             with the symbols the CONVERSION invented.
 *
 *   Two screens need that knowledge — the simulator and the batch runner —
 *   and each would otherwise have to re-derive "which grammar does this
 *   engine actually run on, and what does a result look like". Duplicating
 *   that rule is how the two screens would eventually drift apart, so it
 *   lives here once and both import it.
 *
 *   This module is deliberately DOM-free: it reads application state, calls
 *   the shared core, and returns data. Rendering is the views' business.
 */

import { runCyk } from '/core/cyk.js';
import { runEarley } from '/core/earley.js';
import { isCnf, convertToCnf } from '/core/cnf.js';
import { validateGrammar } from '/core/validator.js';
import { measure } from './measure.js';
import { state } from './app.js';

/* ------------------------------------------------------------------------ */
/* Engine identity                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The engine ids. These strings live in application state and in radio input
 * values, so they are part of the contract between the views — renaming one
 * silently breaks a saved selection.
 */
export const ENGINES = {
  EARLEY: 'earley',
  CYK: 'cyk',
  BOTH: 'both',
};

/** Every engine id, in the order the radio group presents them. */
export const ENGINE_ORDER = [ENGINES.EARLEY, ENGINES.CYK, ENGINES.BOTH];

/**
 * User-facing names: what the engine DOES first, what it is CALLED second.
 * A student choosing between them should not need to already know what
 * "Earley" means in order to make the choice.
 */
export const ENGINE_LABELS = {
  [ENGINES.EARLEY]: 'Parse the grammar directly — no conversion (Earley)',
  [ENGINES.CYK]: 'Convert to Chomsky Normal Form first, then parse (CYK)',
  [ENGINES.BOTH]: 'Run both and compare',
};

/** The short form, for table headers, buttons and verdict lines. */
export const ENGINE_SHORT = {
  [ENGINES.EARLEY]: 'Earley',
  [ENGINES.CYK]: 'CYK',
  [ENGINES.BOTH]: 'both engines',
};

/** One line under each choice, explaining the consequence of picking it. */
export const ENGINE_HINTS = {
  [ENGINES.EARLEY]:
    'Works on any valid grammar, and fills its chart column by column. The parse tree ' +
    'uses the symbols you declared.',
  [ENGINES.CYK]:
    'Shows the table animation step by step. The parse tree uses the converted grammar’s symbols.',
  [ENGINES.BOTH]:
    'The verdict is always the same — the timings are what differ. Either visualisation ' +
    'can be watched.',
};

/** True for an id this module can actually run. */
export function isEngine(value) {
  return ENGINE_ORDER.includes(value);
}

/* ------------------------------------------------------------------------ */
/* Which grammar does each engine run on?                                    */
/* ------------------------------------------------------------------------ */

/**
 * Preference order:
 *   1. the result of the last CNF conversion (state.cnf),
 *   2. the working grammar itself, if it happens to be valid CNF already.
 * Anything else → null (the simulator panel offers an inline conversion).
 *
 * IMPORTANT cross-module invariant: state.cnf.result is trusted here
 * WITHOUT re-validation. That is sound only because app.js clears
 * state.cnf on every grammar edit (see setGrammar/markGrammarEdited) —
 * a stale conversion can never survive a change to its source grammar.
 * Any new code path that mutates the working grammar must preserve this.
 *
 * Moved here from cyk-view.js unchanged once the batch runner needed the
 * same answer; the invariant above is exactly why it must stay one function
 * rather than being copied into the second caller.
 *
 * @returns {object|null} a CNF grammar ready for runCyk, or null.
 */
export function resolveCnfGrammar() {
  if (state.cnf && !state.cnf.emptyLanguage) return state.cnf.result;
  if (state.grammar && validateGrammar(state.grammar).valid && isCnf(state.grammar)) {
    return state.grammar;
  }
  return null;
}

/**
 * The grammar Earley runs on: the user's own, needing nothing but validity.
 * That "nothing but validity" IS the feature — it is the whole reason the
 * engine exists alongside CYK.
 *
 * @returns {object|null}
 */
export function resolveEarleyGrammar() {
  if (state.grammar && validateGrammar(state.grammar).valid) return state.grammar;
  return null;
}

/**
 * Can each engine run right now, and if not, why not? Views use this to
 * disable a choice and explain the reason, rather than letting someone pick
 * an option that would immediately fail with a toast.
 *
 * @returns {Object<string, {ready: boolean, reason: string}>}
 */
export function engineAvailability() {
  const earleyGrammar = resolveEarleyGrammar();
  const cnfGrammar = resolveCnfGrammar();

  const invalidReason = state.grammar
    ? 'The grammar has validation errors — fix them in the editor first.'
    : 'Define a grammar in the editor first.';

  const earley = {
    ready: earleyGrammar !== null,
    reason: earleyGrammar ? '' : invalidReason,
  };

  let cykReason = '';
  if (cnfGrammar === null) {
    if (state.cnf?.emptyLanguage) {
      cykReason = 'The grammar generates the empty language — no string can ever be accepted.';
    } else if (earleyGrammar === null) {
      cykReason = invalidReason;
    } else {
      cykReason = 'The grammar is not in Chomsky Normal Form yet — convert it first.';
    }
  }
  const cyk = { ready: cnfGrammar !== null, reason: cykReason };

  return {
    [ENGINES.EARLEY]: earley,
    [ENGINES.CYK]: cyk,
    [ENGINES.BOTH]: {
      ready: earley.ready && cyk.ready,
      reason: earley.ready ? cyk.reason : earley.reason,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Timing                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Re-exported so this module keeps the surface its callers already know:
 * a view asks engines.js how a run is timed and engines.js answers.
 *
 * measure() itself moved to its own import-free file only because the
 * benchmark script behind docs/algorithms.md §9 runs under Node, where this
 * module cannot be imported at all — see public/js/measure.js.
 */
export { measure };

/* ------------------------------------------------------------------------ */
/* Running                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Run one string through one engine (or through both).
 *
 * The returned RUN RECORD is the single shape every view consumes — the
 * simulator renders it, the parse-tree section builds a tree from it, and
 * the batch runner collects a list of them:
 *
 *   { engine,                  // which choice produced this record
 *     input,                   // the string that was run
 *     accepted,                // the verdict (the AGREED one in 'both' mode)
 *     earley: {result, ms, reps} | null,
 *     cyk:    {grammar, result, ms, reps} | null,  // grammar = the CNF one run
 *     cnfMs, cnfReps,          // conversion cost, 'both' mode only
 *     disagreement }           // true when the engines differed — a BUG
 *
 * Errors are NOT swallowed. Both engines throw typed errors (CykError /
 * EarleyError) whose messages are already written for end users, so callers
 * catch and show err.message verbatim.
 *
 * @param {string} engine One of ENGINES.
 * @param {string} input  The string to test.
 * @returns {object} the run record described above.
 */
export function runOnce(engine, input) {
  const record = {
    engine,
    input,
    accepted: false,
    earley: null,
    cyk: null,
    cnfMs: null,
    cnfReps: 0,
    disagreement: false,
  };

  if (engine === ENGINES.EARLEY || engine === ENGINES.BOTH) {
    const grammar = resolveEarleyGrammar();
    if (grammar === null) {
      throw new Error('No valid grammar to parse — fix the problems in the editor first.');
    }
    const { value, ms, reps } = measure(() => runEarley(grammar, input));
    record.earley = { result: value, ms, reps };
  }

  if (engine === ENGINES.CYK || engine === ENGINES.BOTH) {
    const grammar = resolveCnfGrammar();
    if (grammar === null) {
      throw new Error('No CNF grammar available — convert the grammar first.');
    }
    const { value, ms, reps } = measure(() => runCyk(grammar, input));
    record.cyk = { grammar, result: value, ms, reps };
  }

  // The conversion is timed only when the point of the run is to compare it.
  //
  // It is charged SEPARATELY and never folded into CYK's per-string figure: a
  // grammar is converted once and the result reused for every string after
  // it, so adding the conversion to each string would overstate CYK by a
  // factor of however many strings were run — exactly the mistake the
  // comparison chapter exists to avoid.
  if (engine === ENGINES.BOTH) {
    const source = resolveEarleyGrammar();
    const { ms, reps } = measure(() => convertToCnf(source));
    record.cnfMs = ms;
    record.cnfReps = reps;
  }

  if (record.earley && record.cyk) {
    record.disagreement = record.earley.result.accepted !== record.cyk.result.accepted;
    // Report Earley's verdict when they differ: it ran on the grammar the
    // user actually wrote, so it is the one they can reason about. The
    // disagreement flag is what the UI shouts about — neither verdict is
    // trustworthy once they disagree.
    record.accepted = record.earley.result.accepted;
  } else if (record.earley) {
    record.accepted = record.earley.result.accepted;
  } else {
    record.accepted = record.cyk.result.accepted;
  }

  return record;
}
