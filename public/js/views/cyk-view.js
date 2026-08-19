/**
 * public/js/views/cyk-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The Simulator section — testing one string against the grammar.
 *
 *   The file is still called cyk-view because the CYK animation is the bulk
 *   of what it does, but the section now offers a CHOICE of engine and this
 *   module owns that choice's UI:
 *
 *     - presents the engine radio group (Earley / CYK / both) and keeps it
 *       in step with state.engine, which the batch runner shares,
 *     - shows the grammar each engine actually runs on: the user's own for
 *       Earley, the CNF conversion for CYK (with a one-click inline
 *       conversion when none exists yet),
 *     - runs the string through engines.js, then REPLAYS the recorded step
 *       trace through the StepPlayer (animations.js), which drives either
 *       visualisation: CYK's table, built here, or Earley's chart, built by
 *       earley-chart.js. Both fill in one step at a time, highlight what the
 *       step is working on and where it came from, flash the rules used in
 *       the grammar panel, and explain themselves in a live caption,
 *     - shows the Accepted / Rejected verdict, the engine comparison table
 *       when both ran, and hands accepted runs to the Parse Tree section.
 *
 *   A run in 'both' mode has TWO traces, so the card offers a choice of which
 *   one to watch. Picking one rebuilds the player against that trace and swaps
 *   the grammar panel to the grammar that engine actually ran on.
 *
 * DOM contract (views/index.html):
 *   #cykEngineChoice #cykGrammarCardTitle
 *   #cykGrammar #cykInput #btnRunCyk #cykSimCard #cykSimTitle #cykPlayback
 *   #cykTableWrap #earleyChartWrap #cykExplanation #cykProgress #cykVerdict
 *   #simCompare #simTraceChoice #simTraceEarley #simTraceCyk
 *   #btnCykPlay #btnCykStepBack #btnCykStepFwd #btnCykSkip #btnCykReset #cykSpeed
 */

import { convertToCnf } from '/core/cnf.js';
import { productionKey, EPSILON } from '/core/grammar.js';
import { state, events, emit, navigateTo, setEngine } from '../app.js';
import { escapeHtml, showToast, initTooltips } from '../ui.js';
import { grammarHtml, symbolHtml, productionHtml } from '../grammar-render.js';
import { StepPlayer } from '../animations.js';
import {
  ENGINES,
  ENGINE_ORDER,
  ENGINE_LABELS,
  ENGINE_HINTS,
  engineAvailability,
  resolveCnfGrammar,
  resolveEarleyGrammar,
  runOnce,
} from '../engines.js';
import {
  ANIMATED_MAX_LENGTH,
  createChartRenderer,
  renderUnavailable,
} from '../earley-chart.js';

const els = {};
let player = null;
/** Live mirror of each cell's variables while replaying: "i:l" → string[]. */
let cellContents = new Map();
/**
 * Which trace the player is replaying: 'earley', 'cyk', or null when the run
 * has nothing to replay. Held at module level because the two-trace toggle
 * has to rebuild the player without re-running the parse.
 */
let trace = null;

/**
 * Operation tints earley-chart.js puts on the shared caption. Listed here too
 * because the CYK path has to strip them: it writes plain text into the same
 * element and would otherwise inherit the last chart step's colour.
 */
const CAPTION_OP_CLASSES = ['op-predict', 'op-scan', 'op-complete'];

export function init() {
  els.engineChoice = document.getElementById('cykEngineChoice');
  els.grammarTitle = document.getElementById('cykGrammarCardTitle');
  els.grammar = document.getElementById('cykGrammar');
  els.input = document.getElementById('cykInput');
  els.runButton = document.getElementById('btnRunCyk');
  els.simCard = document.getElementById('cykSimCard');
  els.simTitle = document.getElementById('cykSimTitle');
  els.playback = document.getElementById('cykPlayback');
  els.tableWrap = document.getElementById('cykTableWrap');
  els.chartWrap = document.getElementById('earleyChartWrap');
  els.traceChoice = document.getElementById('simTraceChoice');
  els.explanation = document.getElementById('cykExplanation');
  els.progress = document.getElementById('cykProgress');
  els.verdict = document.getElementById('cykVerdict');
  els.compare = document.getElementById('simCompare');
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

  // Switching trace re-runs nothing: the record already holds both results,
  // so this only tears the player down and builds one against the other one.
  for (const choice of els.traceChoice.querySelectorAll('input[name="simTrace"]')) {
    choice.addEventListener('change', () => {
      if (!state.run) return;
      trace = choice.value;
      teardownPlayerOnly();
      renderGrammarPanel();
      renderSimulationChrome(state.run);
      startPlayer(state.run);
    });
  }

  const invalidate = () => {
    teardownSimulation();
    renderEngineChoice();
    renderGrammarPanel();
  };
  events.addEventListener('grammar-changed', invalidate);
  events.addEventListener('grammar-loaded', invalidate);
  events.addEventListener('cnf-computed', () => {
    renderEngineChoice();
    renderGrammarPanel();
  });
  // Switching engine drops the previous run (app.js clears state.run), so the
  // simulation card must go with it rather than keep showing another engine's
  // verdict under the new selection.
  events.addEventListener('engine-changed', invalidate);
  events.addEventListener('section-shown', (event) => {
    if (event.detail?.name === 'cyk') {
      renderEngineChoice();
      renderGrammarPanel();
    }
  });

  // The batch runner asks for one of its rows to be shown in detail here.
  // It navigates first, so by the time this fires the section is laid out
  // and the CYK table can measure itself.
  events.addEventListener('simulate-request', (event) => {
    els.input.value = event.detail?.input ?? '';
    run();
  });

  renderEngineChoice();
  renderGrammarPanel();
}

/* ------------------------------------------------------------------------ */
/* Engine selection                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Paint the engine radio group from state.engine, disabling any choice that
 * cannot run right now and saying why. Rebuilt wholesale on every call, so
 * listeners never accumulate.
 */
function renderEngineChoice() {
  const availability = engineAvailability();

  els.engineChoice.innerHTML = ENGINE_ORDER.map((engine) => {
    const { ready, reason } = availability[engine];
    const id = `engine-${engine}`;
    const checked = state.engine === engine ? 'checked' : '';
    const disabled = ready ? '' : 'disabled';
    const hint = ready ? ENGINE_HINTS[engine] : reason;
    return `
      <div class="form-check engine-choice">
        <input class="form-check-input" type="radio" name="cykEngine" id="${id}"
               value="${engine}" ${checked} ${disabled}>
        <label class="form-check-label" for="${id}">
          ${escapeHtml(ENGINE_LABELS[engine])}
          <span class="d-block form-text mt-0">${escapeHtml(hint)}</span>
        </label>
      </div>`;
  }).join('');

  for (const input of els.engineChoice.querySelectorAll('input[name="cykEngine"]')) {
    input.addEventListener('change', () => setEngine(input.value));
  }

  const ready = availability[state.engine].ready;
  els.runButton.disabled = !ready;
  els.runButton.innerHTML =
    '<i class="bi bi-play-fill" aria-hidden="true"></i> ' +
    (state.engine === ENGINES.BOTH ? 'Run both' : `Run ${state.engine === ENGINES.EARLEY ? 'Earley' : 'CYK'}`);
}

/* ------------------------------------------------------------------------ */
/* Which grammar does the simulator run on?                                  */
/* ------------------------------------------------------------------------ */

/**
 * Show the grammar the engine on screen will actually run on.
 *
 * The two engines answer this differently, and that difference is the whole
 * point of offering the choice: Earley runs the grammar as written, CYK runs
 * its CNF conversion. Showing the wrong one would make the parse tree's
 * symbols inexplicable.
 *
 * While a run is up the ANIMATED engine decides, not the selected one: in
 * 'both' mode the chart flashes rules of the grammar as written, and those
 * rules have to be the ones on the panel for the flash to land anywhere.
 */
function renderGrammarPanel() {
  const shown = trace ?? (state.engine === ENGINES.EARLEY ? 'earley' : 'cyk');
  if (shown === 'earley') {
    renderOriginalGrammarPanel();
    return;
  }
  renderCnfGrammarPanel();
}

/** The user's own grammar — what Earley parses, unconverted. */
function renderOriginalGrammarPanel() {
  const grammar = resolveEarleyGrammar();
  els.grammarTitle.textContent = 'Grammar as written';

  if (!grammar) {
    els.grammar.innerHTML = `
      <p class="text-secondary mb-0">
        Define a valid grammar in the <a href="#editor">editor</a> first.
      </p>`;
    return;
  }

  // ruleKeys: the chart animation flashes the exact rule each step used, the
  // same way the CNF panel does for the table.
  els.grammar.innerHTML = `
    ${grammarHtml(grammar, { ruleKeys: true })}
    <hr>
    <div class="small text-secondary">
      start: ${symbolHtml(grammar.startSymbol, grammar)} ·
      parsed directly — no Chomsky Normal Form conversion needed
    </div>`;
}

/** The CNF grammar — what CYK parses. Unchanged from before engine choice. */
function renderCnfGrammarPanel() {
  const grammar = resolveCnfGrammar();
  els.grammarTitle.textContent =
    state.engine === ENGINES.BOTH ? 'Grammar in CNF (for CYK)' : 'Grammar in CNF';

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
    return;
  }

  if (state.cnf?.emptyLanguage) {
    els.grammar.innerHTML = `
      <div class="alert alert-warning small mb-0">
        <i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>
        The current grammar generates the empty language — no string can ever be accepted.
      </div>`;
    return;
  }

  const hasUsableGrammar = resolveEarleyGrammar() !== null;
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
           </button>
           <p class="form-text mb-0">
             Or choose direct parsing above, which needs no conversion at all.
           </p>`
        : ''
    }`;

  document.getElementById('btnCykAutoCnf')?.addEventListener('click', () => {
    try {
      state.cnf = convertToCnf(state.grammar);
      emit('cnf-computed');
      renderEngineChoice();
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

/**
 * Execute a simulation: run the selected engine instantly (engines.js), then
 * hand a recorded step trace to a fresh StepPlayer for replay. The animation
 * is therefore a faithful replay of what the algorithm did, never a
 * re-implementation of it.
 */
function run() {
  // Trimmed on purpose: stray spaces are the most common paste accident,
  // and whitespace can never be a terminal anyway (isValidTerminalSymbol).
  const input = els.input.value.trim();

  let record;
  try {
    record = runOnce(state.engine, input);
  } catch (err) {
    showToast(err.message, 'danger', 7000);
    return;
  }

  state.run = record;
  emit('parse-computed');

  els.simCard.classList.remove('d-none');
  teardownPlayerOnly();
  trace = chooseTrace(record);
  renderGrammarPanel();
  renderSimulationChrome(record);
  renderCompare(record);
  startPlayer(record);
}

/**
 * Which of the run's traces should be on screen.
 *
 * A single-engine run has only one candidate. A 'both' run has two and the
 * toggle decides — except that an input past the chart's animation cap makes
 * the chart a dead end, so the table wins on a fresh run and the student is
 * still shown something working. Choosing the chart explicitly afterwards
 * still gets the explanation of why it is not animated.
 *
 * @param {object} record The run record from engines.js.
 * @returns {?string} 'earley', 'cyk', or null when nothing can be replayed.
 */
function chooseTrace(record) {
  if (!record.cyk) return record.earley ? 'earley' : null;
  if (!record.earley) return 'cyk';

  const picked = els.traceChoice.querySelector('input[name="simTrace"]:checked')?.value;
  const chosen =
    picked === 'cyk' || record.input.length > ANIMATED_MAX_LENGTH ? 'cyk' : 'earley';

  // Keep the radio honest about what is actually on screen.
  const button = els.traceChoice.querySelector(
    chosen === 'cyk' ? '#simTraceCyk' : '#simTraceEarley'
  );
  if (button) button.checked = true;
  return chosen;
}

/**
 * Build a player for the chosen trace and start it.
 *
 * Both visualisations meet the StepPlayer through the same four callbacks, so
 * the transport buttons, the speed select and the progress line never learn
 * which of them is on screen.
 *
 * @param {object} record The run record from engines.js.
 */
function startPlayer(record) {
  // The caption is shared, and the chart tints it per operation — clear that
  // before a CYK trace writes a plain explanation into it.
  els.explanation.classList.remove(...CAPTION_OP_CLASSES);

  if (trace === null) {
    els.tableWrap.innerHTML = '';
    els.chartWrap.innerHTML = '';
    renderVerdict({ accepted: record.accepted });
    return;
  }

  // Only one visualisation is ever live. Dropping the other keeps the card
  // from carrying a whole hidden chart or table around between runs.
  if (trace === 'earley') els.tableWrap.innerHTML = '';
  else els.chartWrap.innerHTML = '';

  // Past the cap the parse still ran; only the replay is skipped.
  if (trace === 'earley' && record.input.length > ANIMATED_MAX_LENGTH) {
    renderUnavailable(els.chartWrap, record.earley.result);
    renderVerdict({ accepted: record.accepted });
    return;
  }

  const engineRun = trace === 'earley' ? record.earley : record.cyk;
  const renderer =
    trace === 'earley'
      ? createChartRenderer({
          result: record.earley.result,
          grammar: resolveEarleyGrammar(),
          chartEl: els.chartWrap,
          captionEl: els.explanation,
          grammarEl: els.grammar,
          onVerdict: renderVerdict,
        })
      : { resetView: () => resetView(record.cyk.result), applyStep, stepDelay };

  player = new StepPlayer({
    steps: engineRun.result.steps,
    applyStep: renderer.applyStep,
    resetView: renderer.resetView,
    stepDelay: renderer.stepDelay,
    onProgress: renderProgress,
  });
  player.setSpeed(Number(els.speed.value));
  player.play();
}

/** Stop and drop the current player (its timers must not outlive a run). */
function teardownPlayerOnly() {
  player?.destroy();
  player = null;
}

/** Full reset: player, both visualisations, verdict, caption — on grammar edits. */
function teardownSimulation() {
  teardownPlayerOnly();
  trace = null;
  els.simCard.classList.add('d-none');
  els.tableWrap.innerHTML = '';
  els.chartWrap.innerHTML = '';
  els.verdict.innerHTML = '';
  els.compare.innerHTML = '';
  els.explanation.textContent = '';
  els.explanation.classList.remove(...CAPTION_OP_CLASSES);
  els.progress.textContent = '';
}

/* ------------------------------------------------------------------------ */
/* Engine-dependent chrome                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Show only the parts of the simulation card the run can actually fill.
 *
 * The playback controls and the running caption belong to a trace being
 * replayed; a run with none of them — or one whose chart is past its
 * animation cap — has nothing for them to drive, and leaving them on screen
 * would offer buttons that do nothing.
 *
 * @param {object} record The run record from engines.js.
 */
function renderSimulationChrome(record) {
  const overCap = trace === 'earley' && record.input.length > ANIMATED_MAX_LENGTH;
  const hasTrace = trace !== null && !overCap;

  els.playback.classList.toggle('d-none', !hasTrace);
  els.explanation.classList.toggle('d-none', !hasTrace);
  els.progress.classList.toggle('d-none', !hasTrace);

  els.tableWrap.classList.toggle('d-none', trace !== 'cyk');
  // The chart wrapper stays visible for an over-cap Earley run: that is where
  // the explanation of why there is no animation goes.
  els.chartWrap.classList.toggle('d-none', trace !== 'earley');

  // Only a run with both results has a second trace to offer.
  els.traceChoice.classList.toggle('d-none', !(record.earley && record.cyk));

  els.simTitle.textContent = hasTrace ? 'Simulation' : 'Result';
}

/**
 * The engine comparison table — 'both' mode only.
 *
 * Reports each engine's parse time separately from the CNF conversion,
 * because the conversion is paid ONCE per grammar and then reused for every
 * string after it. Charging it to CYK per string would overstate the cost by
 * however many strings were run.
 *
 * @param {object} record The run record from engines.js.
 */
function renderCompare(record) {
  if (record.engine !== ENGINES.BOTH || !record.earley || !record.cyk) {
    els.compare.innerHTML = '';
    return;
  }

  const verdict = (accepted) => (accepted ? 'Accepted' : 'Rejected');
  const time = (ms, reps) =>
    `${ms.toFixed(3)} ms${reps > 1 ? ` <span class="text-secondary">(mean of ${reps} runs)</span>` : ''}`;

  const agreement = record.disagreement
    ? `<div class="alert alert-danger small mb-0 mt-2" role="alert">
         <i class="bi bi-exclamation-octagon-fill me-1" aria-hidden="true"></i>
         <strong>The two engines disagreed on this string.</strong>
         Both decide the same language, so this is a bug in CFG Studio — not a
         property of your grammar. Please report it with the grammar and the string.
       </div>`
    : `<p class="small text-secondary mb-0 mt-2">
         <i class="bi bi-check2 me-1" aria-hidden="true"></i>
         Both engines agree, as they always must — they decide the same language.
         Only the time taken differs.
       </p>`;

  els.compare.innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm align-middle compare-table mb-0">
        <thead>
          <tr><th scope="col">Engine</th><th scope="col">Verdict</th><th scope="col">Time</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Earley <span class="fw-normal text-secondary">— direct</span></th>
            <td>${verdict(record.earley.result.accepted)}</td>
            <td>${time(record.earley.ms, record.earley.reps)}</td>
          </tr>
          <tr>
            <th scope="row">CYK <span class="fw-normal text-secondary">— via CNF</span></th>
            <td>${verdict(record.cyk.result.accepted)}</td>
            <td>${time(record.cyk.ms, record.cyk.reps)}</td>
          </tr>
          <tr class="compare-aside">
            <th scope="row">CNF conversion</th>
            <td>—</td>
            <td>${time(record.cnfMs, record.cnfReps)} <span class="text-secondary">· one-off per grammar</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    ${agreement}`;
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

/**
 * Append newly derived variables to a cell's mirror + DOM.
 *
 * `cellContents` (Map "i:l" → string[]) mirrors what each cell currently
 * shows. It exists because the StepPlayer replays steps incrementally and
 * out of visual order during seeks — the DOM alone can't be trusted as
 * state, but the mirror can be rebuilt deterministically from any prefix
 * of the trace.
 *
 * @param {number} i         Cell start position (0-based).
 * @param {number} l         Cell substring length.
 * @param {string[]} variables Variables to merge in (duplicates ignored).
 * @param {object} grammar   For symbol colouring.
 * @param {boolean} flash    Animate only when new content actually appeared.
 */
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

/** Remove all step-transient highlight classes (cells + grammar rules). */
function clearHighlights() {
  for (const el of els.tableWrap.querySelectorAll('.cell-active, .cell-src')) {
    el.classList.remove('cell-active', 'cell-src');
  }
  for (const el of els.grammar.querySelectorAll('.cyk-rule.rule-hit')) {
    el.classList.remove('rule-hit');
  }
}

/**
 * Flash the given productions in the grammar panel. Rules are located by
 * their productionKey stored in data-rule-key at render time; CSS.escape
 * guards the attribute selector against symbols like '(' or '"'.
 *
 * @param {object[]} productions Productions used by the current step.
 */
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
  const grammar = state.run.cyk.grammar;
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
      const apex = document.getElementById(cellId(0, state.run.cyk.result.n));
      apex?.classList.add(step.accepted ? 'cell-accept' : 'cell-reject');
      break;
    }
    default: // 'begin' — caption only
  }
}

/**
 * The Accepted/Rejected banner; accepted runs get the "Show parse tree"
 * button that hands over to the tree section (which reads state.run).
 *
 * Takes only {accepted} so it serves every caller: either trace passes its
 * own 'verdict' step, and a run with no animation to replay — no trace at
 * all, or a chart past its cap — passes the run record's verdict directly.
 *
 * @param {{accepted: boolean}} step The verdict to display.
 */
function renderVerdict(step) {
  const { input } = state.run;
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

/**
 * Base display duration per step type (ms) — 'combine' steps get the most
 * time because they carry the actual reasoning; the StepPlayer divides
 * these by the user's speed multiplier.
 *
 * @param {object} step A trace step.
 * @returns {number} milliseconds to linger.
 */
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

/**
 * StepPlayer progress callback: step counter text and the play/pause icon
 * (the same button toggles both ways, so its icon mirrors player state).
 *
 * @param {StepPlayer} p The player reporting progress.
 */
function renderProgress(p) {
  els.progress.textContent = `Step ${p.position} / ${p.length}`;
  els.playButton.innerHTML = p.playing
    ? '<i class="bi bi-pause-fill" aria-hidden="true"></i>'
    : '<i class="bi bi-play-fill" aria-hidden="true"></i>';
  initTooltips(els.simCard);
}
