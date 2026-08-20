/**
 * public/js/measure.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Time a piece of work honestly when the work is faster than the clock.
 *
 *   This lives on its own, apart from engines.js, for one reason: the
 *   benchmark script that produces the figures in docs/algorithms.md §9 runs
 *   under Node, and engines.js cannot be imported there — it resolves the
 *   browser-absolute specifier /core/cyk.js and pulls in the DOM-backed
 *   application state, both at import time. A module with no imports at all
 *   can be loaded by the browser and by Node alike, so the number the
 *   simulator shows and the number the chapter reports come from the same
 *   code rather than from two implementations of the same idea.
 *
 *   performance.now() is a global in both environments, so nothing here is
 *   environment-specific.
 */

/**
 * Below this, a single measurement is not worth reporting.
 *
 * performance.now() is deliberately clamped by browsers (0.1 ms typically,
 * coarser still with privacy.reduceTimerPrecision), so a short parse can
 * measure exactly 0 — which would empty the comparison table precisely on
 * the small grammars a student actually types.
 */
const MIN_MEASURABLE_MS = 1;

/** Upper bound on the extra work a repeat measurement may cost. */
const REPEAT_BUDGET_MS = 20;

/** Belt and braces: never spin, however fast the clock claims the run was. */
const MAX_REPS = 2000;

/**
 * Run `work` once for its result, and time it honestly.
 *
 * A run too short to measure is repeated within a small budget and the MEAN
 * reported instead, together with the number of repetitions — so the figure
 * on screen can say "mean of 128 runs" rather than presenting one clamped
 * sample as though it were a measurement.
 *
 * @param {Function} work Zero-argument function to run and time.
 * @returns {{value: *, ms: number, reps: number}}
 */
export function measure(work) {
  const started = performance.now();
  const value = work();
  let ms = performance.now() - started;
  let reps = 1;

  if (ms < MIN_MEASURABLE_MS) {
    const deadline = performance.now() + REPEAT_BUDGET_MS;
    const repeatStart = performance.now();
    let n = 0;
    while (n < MAX_REPS && performance.now() < deadline) {
      work();
      n += 1;
    }
    const elapsed = performance.now() - repeatStart;
    if (n > 0) {
      ms = elapsed / n;
      reps = n;
    }
  }

  return { value, ms, reps };
}
