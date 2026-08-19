/**
 * public/js/earley-chart.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Draws the Earley chart and replays a run onto it, one step at a time.
 *
 *   This module is a RENDERER, not a view — the same relationship tree.js has
 *   to tree-view.js. cyk-view.js owns the Simulator section, its playback
 *   buttons and its StepPlayer; this file only knows how to turn one recorded
 *   step into pixels. It re-implements no part of the algorithm: core/earley.js
 *   already records the trace, and everything below is a faithful replay of it.
 *
 *   Three things make an Earley chart harder to animate than a CYK table, and
 *   each is answered here rather than in the view:
 *
 *   VOLUME. Earley emits far more steps than CYK — a four-character input runs
 *     to a hundred or so where CYK manages twenty. Past ANIMATED_MAX_LENGTH the
 *     replay is not worth watching, so the view falls back to a verdict and
 *     renderUnavailable() explains why.
 *   WIDTH. An item is a whole dotted rule plus an origin, and a column is a
 *     variable-length list rather than one cell of a neat triangle. Columns are
 *     laid out as vertical lists in one horizontally scrolling strip, and the
 *     renderer keeps whatever the current step is talking about inside it.
 *   COMPLETE JUMPS BACKWARDS. Where CYK always combines two adjacent cells, a
 *     completion reaches back to an arbitrarily earlier column. That source
 *     item is highlighted in the SAME amber CYK uses for its two source cells,
 *     so the convention only has to be learned once.
 */

import { itemToString } from '/core/earley.js';
import { productionKey } from '/core/grammar.js';
import { escapeHtml } from './ui.js';

/**
 * Longest input the chart will animate.
 *
 * Well below core/earley.js's MAX_INPUT_LENGTH of 30, which still governs what
 * the parser will RUN: the cap here is about how many steps a person can
 * follow, not about what the algorithm can compute. Twelve characters runs to
 * around fifty steps on the simplest grammar and several hundred on a dense
 * one — the cap is uniform because the reader should not have to guess which
 * kind of grammar theirs is.
 */
export const ANIMATED_MAX_LENGTH = 12;

/** Caption label per operation — the pill a reader sees before the prose. */
const OP_LABELS = {
  predict: 'PREDICT',
  scan: 'SCAN',
  complete: 'COMPLETE',
};

/** Every class the caption may carry over from a previous step. */
const OP_CLASSES = ['op-predict', 'op-scan', 'op-complete'];

/* ------------------------------------------------------------------------ */
/* The no-animation fallback                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Explain, in the chart's own place, why a run this long is not animated.
 *
 * The parse itself succeeded — only the replay is skipped — so the message
 * says that plainly rather than reading like a failure.
 *
 * @param {HTMLElement} chartEl Where the chart would have gone.
 * @param {object} result The runEarley result that is not being animated.
 */
export function renderUnavailable(chartEl, result) {
  chartEl.innerHTML = `
    <div class="alert alert-secondary small mb-0">
      <i class="bi bi-info-circle me-1" aria-hidden="true"></i>
      <strong>The chart is not animated above ${ANIMATED_MAX_LENGTH}
      characters.</strong>
      This run is ${result.n} characters: ${result.n + 1} columns and
      ${result.steps.length} recorded steps — already wider than the screen,
      and a denser grammar at this length runs to several hundred steps. The
      parse itself ran in full: the verdict is below, and an accepted string
      still has its complete parse tree in the Parse Tree section.
    </div>`;
}

/* ------------------------------------------------------------------------ */
/* The renderer                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Build a renderer bound to one run.
 *
 * The returned object is exactly the trio StepPlayer asks for, so the view
 * hands it straight over and keeps no chart state of its own.
 *
 * @param {object} o.result A runEarley result: {chart, steps, input, n, ...}.
 * @param {object} o.grammar The grammar Earley ran on (for symbol kinds).
 * @param {HTMLElement} o.chartEl Container the chart is drawn into.
 * @param {HTMLElement} o.captionEl The live step caption.
 * @param {HTMLElement} o.grammarEl The grammar panel, for flashing rules.
 * @param {Function} o.onVerdict Called with the 'verdict' step; the banner
 *   belongs to the view, which also renders it for runs that have no trace.
 * @returns {{resetView: Function, applyStep: Function, stepDelay: Function}}
 */
export function createChartRenderer({
  result,
  grammar,
  chartEl,
  captionEl,
  grammarEl,
  onVerdict,
}) {
  const { chart, input, n, startSymbol } = result;
  const variables = new Set(grammar.variables);

  /** How many of column 0's items are the seed rather than a prediction. */
  const seeded = countSeeded();

  /**
   * Replay state: how many items of each column are on screen.
   *
   * One number per column is enough because addItem() in core/earley.js only
   * ever APPENDS to a column — so whatever a prefix of the trace has
   * discovered is always a prefix of that column's final item list. That is
   * what makes seeking backwards cheap: StepPlayer has no inverse steps, it
   * resets and silently fast-forwards, and these counters rebuild themselves
   * exactly on the way through.
   */
  let revealed = chart.map(() => 0);

  /** The scrolling strip, looked up again after each resetView() rebuild. */
  let scrollEl = null;

  /* ----------------------------------------------------------------- ids */

  const colId = (c) => `earley-col-${c}`;
  const listId = (c) => `earley-list-${c}`;
  const countId = (c) => `earley-count-${c}`;
  const itemId = (c, i) => `earley-item-${c}-${i}`;

  /* -------------------------------------------------------------- markup */

  /**
   * One symbol as plain coloured text.
   *
   * Deliberately NOT symbolHtml(): its chips carry padding, a background and a
   * border, and a chart column holds dozens of multi-symbol items where a CYK
   * cell holds one short list. The colour is what carries the meaning, so the
   * colour is what is kept.
   *
   * @param {string} text The symbol.
   * @returns {string} HTML span.
   */
  function symbol(text) {
    const kind = variables.has(text) ? 'ei-var' : 'ei-term';
    return `<span class="${kind}">${escapeHtml(text)}</span>`;
  }

  /** One item as `A → α • β (j)`, with the dot and the origin styled apart. */
  function itemHtml(item) {
    const { production, dot, origin } = item;
    const before = production.right.slice(0, dot).map(symbol).join(' ');
    const after = production.right.slice(dot).map(symbol).join(' ');
    return (
      `${symbol(production.left)}<span class="ei-arrow">→</span>` +
      `${before}<span class="ei-dot">•</span>${after}` +
      `<span class="ei-origin">(${origin})</span>`
    );
  }

  /**
   * The input with a dot at position c — the literal meaning of "column c":
   * everything left of the dot has been read, everything right has not.
   *
   * @param {number} c The column.
   * @returns {string} HTML fragment.
   */
  function positionHtml(c) {
    const parts = [];
    for (let k = 0; k < input.length; k += 1) {
      if (k === c) parts.push('<span class="ei-mark">•</span>');
      parts.push(`<span class="ei-ch">${escapeHtml(input[k])}</span>`);
    }
    if (c === input.length) parts.push('<span class="ei-mark">•</span>');
    return parts.join('');
  }

  /** One column: a sticky header above the list of its items. */
  function columnHtml(c) {
    const items = chart[c].items
      .map((item, i) => {
        const done = item.dot === item.production.right.length ? ' item-complete' : '';
        return (
          `<li class="earley-item item-hidden${done}" id="${itemId(c, i)}" ` +
          `title="${escapeHtml(itemToString(item))}">${itemHtml(item)}</li>`
        );
      })
      .join('');

    return `
      <div class="earley-col" id="${colId(c)}">
        <div class="earley-col-head">
          <span class="earley-col-index">Column ${c}</span>
          <span class="earley-col-pos">${positionHtml(c)}</span>
          <span class="earley-col-count" id="${countId(c)}">empty</span>
        </div>
        <ol class="earley-items" id="${listId(c)}">${items}</ol>
      </div>`;
  }

  /* --------------------------------------------------------------- state */

  /**
   * The seed is the leading run of column 0 made of start-symbol rules dotted
   * at the front. Exact, because core/earley.js seeds the column before the
   * main loop starts and adds nothing else of that shape afterwards — a later
   * prediction of the start symbol finds every one of its rules already there.
   *
   * @returns {number} how many leading items of column 0 were seeded.
   */
  function countSeeded() {
    const items = chart[0].items;
    let k = 0;
    while (k < items.length) {
      const item = items[k];
      if (item.dot !== 0 || item.origin !== 0 || item.production.left !== startSymbol) break;
      k += 1;
    }
    return k;
  }

  /**
   * Bring column `c` up to `count` items on screen. Never goes backwards, so
   * applying a step twice during a seek is harmless.
   *
   * @param {number} c Column index.
   * @param {number} count How many of its items should now be visible.
   */
  function reveal(c, count) {
    const items = chart[c]?.items;
    if (!items) return;
    const target = Math.min(count, items.length);
    if (target <= revealed[c]) return;

    for (let i = revealed[c]; i < target; i += 1) {
      document.getElementById(itemId(c, i))?.classList.remove('item-hidden');
    }
    revealed[c] = target;

    const counter = document.getElementById(countId(c));
    if (counter) counter.textContent = target === 1 ? '1 item' : `${target} items`;
  }

  /* ---------------------------------------------------------- highlights */

  /** Wipe every class belonging to the step that is leaving the screen. */
  function clearHighlights() {
    for (const el of chartEl.querySelectorAll('.item-active, .item-src, .col-active, .ch-hit')) {
      el.classList.remove('item-active', 'item-src', 'col-active', 'ch-hit', ...OP_CLASSES);
    }
    for (const el of grammarEl.querySelectorAll('.cyk-rule.rule-hit')) {
      el.classList.remove('rule-hit');
    }
  }

  /** Ring the item the step is working on, in that operation's colour. */
  function markActive(c, i, op) {
    document.getElementById(itemId(c, i))?.classList.add('item-active', `op-${op}`);
    document.getElementById(colId(c))?.classList.add('col-active');
  }

  /** The CYK source-cell convention, applied to an item. */
  function markSource(c, i) {
    document.getElementById(itemId(c, i))?.classList.add('item-src');
  }

  /** Restart the flash animation on an item that has just appeared. */
  function flash(c, i) {
    const el = document.getElementById(itemId(c, i));
    if (!el) return;
    el.classList.remove('item-flash');
    void el.offsetWidth; // force reflow, or the animation will not replay
    el.classList.add('item-flash');
  }

  /** Light the input character a scan is testing, in its own column header. */
  function markChar(c, k) {
    document.getElementById(colId(c))?.querySelectorAll('.ei-ch')[k]?.classList.add('ch-hit');
  }

  /**
   * Flash rules in the grammar panel, located by the productionKey written
   * into data-rule-key at render time. CSS.escape guards the attribute
   * selector against terminals like '(' or '"'.
   *
   * @param {object[]} productions Productions the current step is using.
   */
  function highlightRules(productions) {
    for (const production of productions) {
      grammarEl
        .querySelector(`.cyk-rule[data-rule-key="${CSS.escape(productionKey(production))}"]`)
        ?.classList.add('rule-hit');
    }
  }

  /**
   * Which item did this completion come FROM?
   *
   * The trace records a completion's targets but not its sources, because the
   * chart already holds them: every advanced item keeps a backpointer pair
   * {back, child} for the route that produced it. Exactly one endpoint of that
   * pair is the item this step is about, so the other is the partner — and
   * filtering on this step's own item is what stops routes merged by an
   * EARLIER completion from lighting up as well.
   *
   * It resolves both forms of the operation without a special case:
   *   - a normal completion sits at `child`, so the partner is `back`: the
   *     waiting item back in column step.origin — the backwards jump;
   *   - the nullable repair sits at `back` instead, because there the step's
   *     item is the one waiting, so the partner is `child`: the ε-completion.
   *
   * @param {object} step A 'complete' step.
   * @returns {Array<{column: number, index: number}>} the partner items.
   */
  function sourcesFor(step) {
    const isStepItem = (p) => p.column === step.column && p.index === step.index;
    const sources = [];
    const seen = new Set();

    for (const advanced of step.advanced) {
      const item = chart[advanced.column]?.items[advanced.index];
      if (!item) continue;

      for (const derivation of item.derivations) {
        if (derivation.type !== 'complete') continue;
        const fromBack = isStepItem(derivation.back);
        if (!fromBack && !isStepItem(derivation.child)) continue;

        const partner = fromBack ? derivation.child : derivation.back;
        const key = `${partner.column}:${partner.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push(partner);
      }
    }
    return sources;
  }

  /* ----------------------------------------------------------- scrolling */

  /**
   * Keep the columns a step spans inside the strip, and the active item inside
   * the column. Scrolling writes scrollLeft/scrollTop on the strip itself
   * rather than calling scrollIntoView(), which would drag the whole page.
   *
   * Nothing moves while the range is already visible, so consecutive steps in
   * one column do not make the chart twitch.
   *
   * @param {number[]} columns Columns this step touches.
   * @param {?{column: number, index: number}} item The item to keep in view.
   * @param {boolean} animate Smooth while playing, instant while seeking.
   */
  function focus(columns, item, animate) {
    if (!scrollEl) return;
    const options = { behavior: animate ? 'smooth' : 'auto' };

    const first = document.getElementById(colId(Math.min(...columns)));
    const last = document.getElementById(colId(Math.max(...columns)));
    if (first && last) {
      const start = first.offsetLeft;
      const end = last.offsetLeft + last.offsetWidth;
      const view = scrollEl.clientWidth;
      if (start < scrollEl.scrollLeft || end > scrollEl.scrollLeft + view) {
        // Centre the whole range when it fits; otherwise the last column wins,
        // because that is where the step's result lands.
        const left =
          end - start <= view
            ? start - (view - (end - start)) / 2
            : last.offsetLeft - (view - last.offsetWidth) / 2;
        options.left = Math.max(0, left);
      }
    }

    if (item) {
      const el = document.getElementById(itemId(item.column, item.index));
      if (el) {
        const view = scrollEl.clientHeight;
        const above = el.offsetTop < scrollEl.scrollTop;
        const below = el.offsetTop + el.offsetHeight > scrollEl.scrollTop + view;
        if (above || below) {
          options.top = Math.max(0, el.offsetTop - (view - el.offsetHeight) / 2);
        }
      }
    }

    if (options.left !== undefined || options.top !== undefined) scrollEl.scrollTo(options);
  }

  /* -------------------------------------------------- StepPlayer contract */

  /** Draw the whole chart with every item hidden, ready to be filled in. */
  function resetView() {
    revealed = chart.map(() => 0);
    captionEl.classList.remove(...OP_CLASSES);
    captionEl.textContent = '';

    const columns = [];
    for (let c = 0; c <= n; c += 1) columns.push(columnHtml(c));

    chartEl.innerHTML = `
      <div class="earley-chart" role="group" aria-label="Earley chart">
        ${columns.join('')}
      </div>`;
    scrollEl = chartEl.querySelector('.earley-chart');
  }

  /**
   * Render one step. Anything stateful — revealing items, closing a column,
   * the verdict — runs unconditionally so a silent seek reproduces exactly the
   * same chart; anything cosmetic is gated behind `animate`.
   *
   * @param {object} step The trace step to apply.
   * @param {{animate: boolean}} options
   */
  function applyStep(step, { animate }) {
    clearHighlights();
    renderCaption(step);

    switch (step.type) {
      case 'predict': {
        if (step.added.length > 0) reveal(step.column, Math.max(...step.added) + 1);
        if (animate) {
          markActive(step.column, step.index, 'predict');
          for (const i of step.added) flash(step.column, i);
          // Every rule of the predicted symbol, not only the new ones: when
          // they are all present already, that is precisely what the step says.
          highlightRules(grammar.productions.filter((p) => p.left === step.symbol));
          focus([step.column], { column: step.column, index: step.index }, true);
        }
        break;
      }

      case 'scan': {
        if (step.matched) reveal(step.column + 1, step.target + 1);
        if (animate) {
          markActive(step.column, step.index, 'scan');
          markChar(step.column, step.column);
          highlightRules([chart[step.column].items[step.index].production]);
          if (step.matched) flash(step.column + 1, step.target);
          focus(
            step.matched ? [step.column, step.column + 1] : [step.column],
            { column: step.column, index: step.index },
            true
          );
        }
        break;
      }

      case 'complete': {
        for (const advanced of step.advanced) reveal(advanced.column, advanced.index + 1);
        if (animate) {
          markActive(step.column, step.index, 'complete');
          const sources = sourcesFor(step);
          for (const source of sources) markSource(source.column, source.index);
          for (const advanced of step.advanced) flash(advanced.column, advanced.index);
          highlightRules([chart[step.column].items[step.index].production]);
          focus(
            [step.column, step.origin, ...sources.map((source) => source.column)],
            { column: step.column, index: step.index },
            true
          );
        }
        break;
      }

      case 'column-done': {
        // The authoritative size: whatever the payloads above did not name,
        // this reveals, so no item is ever left behind hidden.
        reveal(step.column, step.size);
        document.getElementById(colId(step.column))?.classList.add('col-done');
        if (animate) focus([step.column], null, true);
        break;
      }

      case 'verdict': {
        markVerdict(step);
        onVerdict(step);
        break;
      }

      default: {
        // 'begin' — the seed appears here rather than in resetView(), so that
        // the caption describing it and the items it describes arrive together.
        reveal(0, seeded);
        if (animate) focus([0], null, true);
      }
    }
  }

  /** The caption: an operation pill, then the step's own explanation. */
  function renderCaption(step) {
    captionEl.classList.remove(...OP_CLASSES);

    const label = OP_LABELS[step.type];
    if (!label) {
      captionEl.textContent = step.explanation;
      return;
    }

    captionEl.classList.add(`op-${step.type}`);
    captionEl.innerHTML =
      `<span class="earley-op op-${step.type}">` +
      `${escapeHtml(step.nullableRepair ? `${label} ε` : label)}</span>` +
      escapeHtml(step.explanation);
  }

  /**
   * Mark the outcome on the chart itself, as CYK marks its apex: the completed
   * start-symbol items that carried the verdict, or the final column when
   * there were none.
   *
   * @param {{accepted: boolean}} step The verdict step.
   */
  function markVerdict(step) {
    if (!step.accepted) {
      document.getElementById(colId(n))?.classList.add('col-reject');
      return;
    }

    chart[n].items.forEach((item, i) => {
      const complete = item.dot === item.production.right.length;
      if (item.production.left === startSymbol && item.origin === 0 && complete) {
        document.getElementById(itemId(n, i))?.classList.add('item-accept');
      }
    });
  }

  /**
   * Base display duration per step type (ms), divided by the user's speed.
   * COMPLETE gets the most, for the same reason CYK gives its 'combine' step
   * the most: it is where the reasoning is.
   *
   * @param {object} step A trace step.
   * @returns {number} milliseconds to linger.
   */
  function stepDelay(step) {
    switch (step.type) {
      case 'begin':
        return 1400;
      case 'predict':
        return 700;
      case 'scan':
        return 700;
      case 'complete':
        return 1000;
      case 'column-done':
        return 500;
      case 'verdict':
        return 1300;
      default:
        return 800;
    }
  }

  return { resetView, applyStep, stepDelay };
}
