/**
 * public/js/views/cyk-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The CYK Simulator section:
 *     - resolves which CNF grammar to run (the last conversion result, or
 *       the working grammar itself if it is already CNF, with a one-click
 *       inline conversion otherwise),
 *     - runs the shared algorithm (core/cyk.js) instantly, then REPLAYS its
 *       recorded step trace through the StepPlayer (animations.js):
 *       cells fill one by one, the current cell and its two source cells
 *       are highlighted, the rules used are flashed in the grammar panel,
 *       and every step is explained in a live caption,
 *     - shows the Accepted / Rejected verdict and hands accepted runs over
 *       to the Parse Tree section.
 *
 * DOM contract (views/index.html):
 *   #cykGrammar #cykInput #btnRunCyk #cykSimCard #cykTableWrap
 *   #cykExplanation #cykProgress #cykVerdict
 *   #btnCykPlay #btnCykStepBack #btnCykStepFwd #btnCykSkip #btnCykReset #cykSpeed
 */

import { runCyk } from '/core/cyk.js';
import { isCnf, convertToCnf } from '/core/cnf.js';
import { validateGrammar } from '/core/validator.js';
import { productionKey, EPSILON } from '/core/grammar.js';
import { state, events, emit, navigateTo } from '../app.js';
import { escapeHtml, showToast, initTooltips } from '../ui.js';
import { grammarHtml, symbolHtml, productionHtml } from '../grammar-render.js';
import { StepPlayer } from '../animations.js';

const els = {};
let player = null;
/** Live mirror of each cell's variables while replaying: "i:l" → string[]. */
let cellContents = new Map();

export function init() {
  els.grammar = document.getElementById('cykGrammar');
  els.input = document.getElementById('cykInput');
  els.runButton = document.getElementById('btnRunCyk');
  els.simCard = document.getElementById('cykSimCard');
  els.tableWrap = document.getElementById('cykTableWrap');
  els.explanation = document.getElementById('cykExplanation');
  els.progress = document.getElementById('cykProgress');
  els.verdict = document.getElementById('cykVerdict');
  els.playButton = document.getElementById('btnCykPlay');
  els.speed = document.getElementById('cykSpeed');

  els.runButton.addEventListener('click', run);
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run();
  });

  els.playButton.addEventListener('click', () => player?.toggle());
  document.getElementById('btnCykStepBack').addEventListener('click', () => player?.stepBack());
  document.getElementById('btnCykStepFwd').addEventListener('click', () => player?.stepForward());
  document.getElementById('btnCykSkip').addEventListener('click', () => player?.skipToEnd());
  document.getElementById('btnCykReset').addEventListener('click', () => player?.seek(0));
  els.speed.addEventListener('change', () => player?.setSpeed(Number(els.speed.value)));

  const invalidate = () => {
    teardownSimulation();
    renderGrammarPanel();
  };
  events.addEventListener('grammar-changed', invalidate);
  events.addEventListener('grammar-loaded', invalidate);
  events.addEventListener('cnf-computed', renderGrammarPanel);
  events.addEventListener('section-shown', (event) => {
    if (event.detail?.name === 'cyk') renderGrammarPanel();
  });

  renderGrammarPanel();
}

/* ------------------------------------------------------------------------ */
/* Which grammar does the simulator run on?                                  */
/* ------------------------------------------------------------------------ */

/**
 * Preference order:
 *   1. the result of the last CNF conversion (state.cnf),
 *   2. the working grammar itself, if it happens to be valid CNF already.
 * Anything else → null (the panel offers an inline conversion).
 */
function resolveCnfGrammar() {
  if (state.cnf && !state.cnf.emptyLanguage) return state.cnf.result;
  if (state.grammar && validateGrammar(state.grammar).valid && isCnf(state.grammar)) {
    return state.grammar;
  }
  return null;
}

function renderGrammarPanel() {
  const grammar = resolveCnfGrammar();

  if (grammar) {
    // data-rule-key lets combine-steps flash the exact rules being used.
    const rulesHtml = grammar.productions
      .map(
        (production) => `
        <div class="cyk-rule" data-rule-key="${escapeHtml(productionKey(production))}">
          ${productionHtml(production, grammar)}
        </div>`
      )
      .join('');
    els.grammar.innerHTML = `
      <div class="grammar-display">${rulesHtml}</div>
      <hr>
      <div class="small text-secondary">
        start: ${symbolHtml(grammar.startSymbol, grammar)} ·
        ${state.cnf ? 'from the CNF conversion of the current grammar' : 'the current grammar is already in CNF'}
      </div>`;
    els.runButton.disabled = false;
    return;
  }

  els.runButton.disabled = true;

  if (state.cnf?.emptyLanguage) {
    els.grammar.innerHTML = `
      <div class="alert alert-warning small mb-0">
        <i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>
        The current grammar generates the empty language — no string can ever be accepted.
      </div>`;
    return;
  }

  const hasUsableGrammar = state.grammar && validateGrammar(state.grammar).valid;
  els.grammar.innerHTML = `
    <p class="text-secondary">
      CYK needs a grammar in Chomsky Normal Form. ${
        hasUsableGrammar
          ? 'The current grammar is not in CNF yet.'
          : 'Define a valid grammar in the <a href="#editor">editor</a> first.'
      }
    </p>
    ${
      hasUsableGrammar
        ? `<button type="button" class="btn btn-sm btn-primary" id="btnCykAutoCnf">
             <i class="bi bi-arrow-left-right" aria-hidden="true"></i> Convert to CNF now
           </button>`
        : ''
    }`;

  document.getElementById('btnCykAutoCnf')?.addEventListener('click', () => {
    try {
      state.cnf = convertToCnf(state.grammar);
      emit('cnf-computed');
      renderGrammarPanel();
      showToast('Converted to CNF — see the CNF tab for every step.', 'success');
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Running the simulation                                                    */
/* ------------------------------------------------------------------------ */

function run() {
  const grammar = resolveCnfGrammar();
  if (!grammar) {
    showToast('No CNF grammar available — convert the grammar first.', 'warning');
    return;
  }

  const input = els.input.value.trim();

  let result;
  try {
    result = runCyk(grammar, input);
  } catch (err) {
    showToast(err.message, 'danger', 7000);
    return;
  }

  state.cyk = { grammar, input, result };
  emit('cyk-computed');

  els.simCard.classList.remove('d-none');
  teardownPlayerOnly();

  player = new StepPlayer({
    steps: result.steps,
    applyStep,
    resetView: () => resetView(result),
    stepDelay,
    onProgress: renderProgress,
  });
  player.setSpeed(Number(els.speed.value));
  player.play();
}

function teardownPlayerOnly() {
  player?.destroy();
  player = null;
}

function teardownSimulation() {
  teardownPlayerOnly();
  els.simCard.classList.add('d-none');
  els.tableWrap.innerHTML = '';
  els.verdict.innerHTML = '';
  els.explanation.textContent = '';
  els.progress.textContent = '';
}

/* ------------------------------------------------------------------------ */
/* Table construction + step application                                     */
/* ------------------------------------------------------------------------ */

const cellId = (i, l) => `cyk-cell-${i}-${l}`;

/** Build the empty triangular table: apex (l = n) on top, characters below. */
function resetView(result) {
  const { n, input } = result;
  cellContents = new Map();
  els.verdict.innerHTML = '';
  els.explanation.textContent = '';

  if (n === 0) {
    els.tableWrap.innerHTML = `
      <p class="text-secondary small mb-0">
        The input is ε — the verdict follows directly from the ${escapeHtml(
          result.startSymbol
        )} → ${EPSILON} rule, no table required.
      </p>`;
    return;
  }

  const rows = [];
  for (let l = n; l >= 1; l -= 1) {
    const cells = [];
    for (let i = 0; i <= n - l; i += 1) {
      cells.push(`<td class="cyk-cell" id="${cellId(i, l)}"></td>`);
    }
    rows.push(
      `<tr><th class="cyk-rowlabel" scope="row">${l}</th>${cells.join('')}` +
        `${'<td class="cyk-void"></td>'.repeat(l - 1)}</tr>`
    );
  }

  const header =
    `<tr><th class="cyk-rowlabel">l ╲ w</th>` +
    [...input]
      .map((ch, idx) => `<th class="cyk-char" scope="col">${escapeHtml(ch)}<sub>${idx + 1}</sub></th>`)
      .join('') +
    '</tr>';

  els.tableWrap.innerHTML = `
    <table class="cyk-table" aria-label="CYK table">
      <tbody>${rows.join('')}${header}</tbody>
    </table>`;
}

/** Append newly derived variables to a cell's mirror + DOM. */
function addToCell(i, l, variables, grammar, flash) {
  const key = `${i}:${l}`;
  const existing = cellContents.get(key) ?? [];
  const merged = [...existing];
  for (const variable of variables) {
    if (!merged.includes(variable)) merged.push(variable);
  }
  cellContents.set(key, merged);

  const cell = document.getElementById(cellId(i, l));
  if (!cell) return;
  cell.innerHTML = merged.map((v) => symbolHtml(v, grammar)).join('<span class="cyk-sep">,</span>');
  if (flash && merged.length > existing.length) {
    cell.classList.remove('cell-flash');
    void cell.offsetWidth; // restart the CSS animation
    cell.classList.add('cell-flash');
  }
}

function clearHighlights() {
  for (const el of els.tableWrap.querySelectorAll('.cell-active, .cell-src')) {
    el.classList.remove('cell-active', 'cell-src');
  }
  for (const el of els.grammar.querySelectorAll('.cyk-rule.rule-hit')) {
    el.classList.remove('rule-hit');
  }
}

function highlightRules(productions) {
  for (const production of productions) {
    const el = els.grammar.querySelector(
      `.cyk-rule[data-rule-key="${CSS.escape(productionKey(production))}"]`
    );
    el?.classList.add('rule-hit');
  }
}

/** Render one trace step onto the DOM (idempotent-friendly for replays). */
function applyStep(step, { animate }) {
  const grammar = state.cyk.grammar;
  clearHighlights();
  els.explanation.textContent = step.explanation;

  switch (step.type) {
    case 'init-cell': {
      const cell = document.getElementById(cellId(step.i, 1));
      cell?.classList.add('cell-filled');
      if (animate) cell?.classList.add('cell-active');
      addToCell(step.i, 1, step.matches.map((m) => m.variable), grammar, animate);
      if (step.matches.length === 0 && cell) cell.innerHTML = '<span class="cyk-empty">∅</span>';
      if (animate) highlightRules(step.matches.map((m) => m.production));
      break;
    }
    case 'combine': {
      const target = document.getElementById(cellId(step.i, step.l));
      if (animate) {
        target?.classList.add('cell-active');
        document.getElementById(cellId(step.leftCell.i, step.leftCell.l))?.classList.add('cell-src');
        document.getElementById(cellId(step.rightCell.i, step.rightCell.l))?.classList.add('cell-src');
        highlightRules(step.found.map((f) => f.production));
      }
      if (step.found.length > 0) {
        addToCell(step.i, step.l, step.found.map((f) => f.variable), grammar, animate);
      }
      break;
    }
    case 'cell-done': {
      const cell = document.getElementById(cellId(step.i, step.l));
      cell?.classList.add('cell-filled');
      if (step.vars.length === 0 && cell) cell.innerHTML = '<span class="cyk-empty">∅</span>';
      break;
    }
    case 'verdict': {
      renderVerdict(step);
      const apex = document.getElementById(cellId(0, state.cyk.result.n));
      apex?.classList.add(step.accepted ? 'cell-accept' : 'cell-reject');
      break;
    }
    default: // 'begin' — caption only
  }
}

function renderVerdict(step) {
  const { input } = state.cyk;
  const shownInput = input === '' ? EPSILON : input;
  els.verdict.innerHTML = step.accepted
    ? `<div class="verdict-banner verdict-accepted">
         <i class="bi bi-check-circle-fill" aria-hidden="true"></i>
         <span>Accepted — "<span class="grammar-text">${escapeHtml(shownInput)}</span>" belongs to the language.</span>
         <button type="button" class="btn btn-sm btn-success ms-auto" id="btnShowTree">
           <i class="bi bi-diagram-2" aria-hidden="true"></i> Show parse tree
         </button>
       </div>`
    : `<div class="verdict-banner verdict-rejected">
         <i class="bi bi-x-circle-fill" aria-hidden="true"></i>
         <span>Rejected — "<span class="grammar-text">${escapeHtml(shownInput)}</span>" does not belong to the language.</span>
       </div>`;
  document.getElementById('btnShowTree')?.addEventListener('click', () => navigateTo('tree'));
}

/* ------------------------------------------------------------------------ */
/* Playback chrome                                                           */
/* ------------------------------------------------------------------------ */

function stepDelay(step) {
  switch (step.type) {
    case 'begin':
      return 1300;
    case 'init-cell':
      return 750;
    case 'combine':
      return 950;
    case 'cell-done':
      return 450;
    case 'verdict':
      return 1200;
    default:
      return 800;
  }
}

function renderProgress(p) {
  els.progress.textContent = `Step ${p.position} / ${p.length}`;
  els.playButton.innerHTML = p.playing
    ? '<i class="bi bi-pause-fill" aria-hidden="true"></i>'
    : '<i class="bi bi-play-fill" aria-hidden="true"></i>';
  initTooltips(els.simCard);
}
