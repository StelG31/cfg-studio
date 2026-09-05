/**
 * public/js/views/batch-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The Batch section: run many strings through the selected engine at once
 *   and check each verdict against what the author expected.
 *
 *   Together with the test strings saved on the grammar (core/grammar.js),
 *   this is regression testing for a grammar: change a rule, press one
 *   button, and see at once whether something that used to work has broken.
 *
 *   ASYNCHRONOUS BY DESIGN. The strings are run one at a time with a yield
 *   to the browser between them, so the progress bar actually moves and
 *   Cancel is actually reachable. A plain synchronous loop would block the
 *   main thread for seconds on worst-case input — no repaint, no progress,
 *   no way out — which is exactly the failure this screen exists to avoid.
 *
 * DOM contract (views/index.html):
 *   #batchEngineChoice #batchInput #btnBatchRun #btnBatchRunSaved #btnBatchCancel
 *   #batchProgressWrap #batchProgressBar #batchProgressText
 *   #batchResults #batchSummary
 */

import { EPSILON, EPSILON_ALIASES } from '/core/grammar.js';
import { state, events, emit, navigateTo, setEngine } from '../app.js';
import { escapeHtml, showToast } from '../ui.js';
import {
  ENGINES,
  ENGINE_ORDER,
  ENGINE_LABELS,
  ENGINE_HINTS,
  engineAvailability,
  firstReadyEngine,
  runOnce,
} from '../engines.js';

/** The spec's cap, and the same number the server allows a grammar to save. */
const MAX_BATCH_STRINGS = 50;

const els = {};

/**
 * Generation counter for the running batch.
 *
 * The same idiom as editor-view's `saving` flag: the token, not the disabled
 * button, is the real guard. Bumping it invalidates the loop in flight, so
 * Cancel, a second Run and a grammar edit all stop the previous run through
 * one mechanism.
 */
let runToken = 0;

/** The rows of the last completed (or cancelled) run, for row clicks. */
let results = [];

export function init() {
  els.engineChoice = document.getElementById('batchEngineChoice');
  els.input = document.getElementById('batchInput');
  els.runButton = document.getElementById('btnBatchRun');
  els.runSavedButton = document.getElementById('btnBatchRunSaved');
  els.cancelButton = document.getElementById('btnBatchCancel');
  els.progressWrap = document.getElementById('batchProgressWrap');
  els.progressBar = document.getElementById('batchProgressBar');
  els.progressText = document.getElementById('batchProgressText');
  els.results = document.getElementById('batchResults');
  els.summary = document.getElementById('batchSummary');

  els.runButton.addEventListener('click', () => startRun(readInput()));
  els.runSavedButton.addEventListener('click', runSavedTestStrings);
  els.cancelButton.addEventListener('click', cancelRun);

  // A run describes one grammar. The moment that grammar changes underneath
  // it, every row already on screen is about something that no longer
  // exists — so stop, and say so rather than leaving stale verdicts up.
  const invalidate = () => {
    if (isRunning()) {
      cancelRun();
      showToast('Batch stopped — the grammar changed while it was running.', 'info');
    }
    renderEngineChoice();
    renderSavedButton();
  };
  events.addEventListener('grammar-changed', invalidate);
  events.addEventListener('grammar-loaded', invalidate);
  events.addEventListener('user-changed', invalidate);
  const refreshControls = () => {
    renderEngineChoice();
    renderSavedButton();
  };
  events.addEventListener('cnf-computed', refreshControls);
  events.addEventListener('engine-changed', refreshControls);
  events.addEventListener('section-shown', (event) => {
    if (event.detail?.name === 'batch') {
      renderEngineChoice();
      renderSavedButton();
    }
  });

  renderEngineChoice();
  renderSavedButton();
}

/* ------------------------------------------------------------------------ */
/* Engine selection (shared with the simulator through state.engine)         */
/* ------------------------------------------------------------------------ */

function renderEngineChoice() {
  const availability = engineAvailability();

  // Same rule as the simulator: a selection that cannot run is moved before
  // anything is painted, rather than shown checked-and-disabled over a dead
  // Run button. firstReadyEngine() in engines.js explains the one bounce.
  if (!availability[state.engine].ready) {
    const fallback = firstReadyEngine();
    if (fallback !== null) {
      setEngine(fallback);
      return;
    }
  }

  els.engineChoice.innerHTML = ENGINE_ORDER.map((engine) => {
    const { ready, reason } = availability[engine];
    const id = `batch-engine-${engine}`;
    return `
      <div class="form-check engine-choice">
        <input class="form-check-input" type="radio" name="batchEngine" id="${id}"
               value="${engine}" ${state.engine === engine ? 'checked' : ''}
               ${ready ? '' : 'disabled'}>
        <label class="form-check-label" for="${id}">
          ${escapeHtml(ENGINE_LABELS[engine])}
          <span class="d-block form-text mt-0">${escapeHtml(ready ? ENGINE_HINTS[engine] : reason)}</span>
        </label>
      </div>`;
  }).join('');

  for (const input of els.engineChoice.querySelectorAll('input[name="batchEngine"]')) {
    input.addEventListener('change', () => setEngine(input.value));
  }

  els.runButton.disabled = !availability[state.engine].ready || isRunning();
}

/**
 * The saved-strings button needs both halves to be true: strings to run, and
 * an engine able to run them. Checking only the first would leave a live
 * button that answers with a toast — the engine radio already explains the
 * problem, so the button should simply follow it.
 */
function renderSavedButton() {
  const saved = savedTestStrings();
  const total = saved.accept.length + saved.reject.length;
  const ready = engineAvailability()[state.engine].ready;

  els.runSavedButton.disabled = total === 0 || !ready || isRunning();
  if (total === 0) {
    els.runSavedButton.title = 'This grammar has no saved test strings yet';
  } else if (!ready) {
    els.runSavedButton.title = 'The selected engine cannot run yet';
  } else {
    els.runSavedButton.title = `Run all ${total} saved strings`;
  }
}

function savedTestStrings() {
  return state.grammar?.testStrings ?? { accept: [], reject: [] };
}

/* ------------------------------------------------------------------------ */
/* Reading the input                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Turn the textarea into a list of strings.
 *
 * A blank line is genuinely ambiguous — it could mean "the empty string" or
 * just be blank — so blank lines are ignored and a line reading ε (or any of
 * the aliases the editor already accepts) is the unambiguous way to ask for
 * it. That is sound because ε is a reserved terminal: it can never be a real
 * character of the alphabet, so nothing else could have been meant.
 *
 * @returns {string[]} at most MAX_BATCH_STRINGS strings.
 */
function readInput() {
  const lines = els.input.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => (EPSILON_ALIASES.has(line) ? '' : line));

  if (lines.length > MAX_BATCH_STRINGS) {
    showToast(
      `Only the first ${MAX_BATCH_STRINGS} strings were taken — ${lines.length} were given.`,
      'warning',
      6000
    );
  }
  return lines.slice(0, MAX_BATCH_STRINGS);
}

/**
 * Load the grammar's saved test strings into the box, then run them.
 *
 * Filling the visible textarea rather than running a hidden list means the
 * student can see exactly what is about to run, and edit it before or after.
 */
function runSavedTestStrings() {
  const saved = savedTestStrings();
  const all = [...saved.accept, ...saved.reject];
  if (all.length === 0) return;

  // The empty string has to go back as the ε alias, or reading the box again
  // would silently drop it as a blank line.
  els.input.value = all.map((value) => (value === '' ? EPSILON : value)).join('\n');
  startRun(all.slice(0, MAX_BATCH_STRINGS));
}

/* ------------------------------------------------------------------------ */
/* The run loop                                                              */
/* ------------------------------------------------------------------------ */

function isRunning() {
  return !els.cancelButton.classList.contains('d-none');
}

/**
 * Hand control back to the browser between strings.
 *
 * setTimeout and NOT queueMicrotask / await null: a microtask never returns
 * to the event loop, so nothing would repaint and the progress bar would
 * jump from 0 to 100 at the end — the freeze this screen exists to prevent,
 * merely with extra steps. The nested-timer clamp costs roughly 4 ms per
 * string after the fifth, so a full 50-string batch spends about 200 ms
 * yielding. That is a fair price for a UI that stays alive.
 */
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Run one string and turn it into a results row.
 *
 * A single bad string must never abort the batch: an invalid character or an
 * over-long input throws, and with 50 strings queued the useful thing is to
 * report that one row and carry on.
 *
 * @param {string} value    The string to run.
 * @param {Map} expectations string → 'accept' | 'reject'.
 * @returns {object} a row descriptor for renderRow().
 */
function runString(value, expectations) {
  const expected = expectations.get(value) ?? null;
  try {
    const record = runOnce(state.engine, value);
    return {
      input: value,
      error: null,
      accepted: record.accepted,
      disagreement: record.disagreement,
      expected,
      matched: expected === null ? null : record.accepted === (expected === 'accept'),
    };
  } catch (err) {
    return {
      input: value,
      error: err.message,
      accepted: null,
      disagreement: false,
      expected,
      // An error is never a pass, even when nothing was expected of it.
      matched: expected === null ? null : false,
    };
  }
}

/**
 * Run every string, yielding between them.
 *
 * @param {string[]} strings The strings to run, already capped and cleaned.
 */
async function startRun(strings) {
  if (strings.length === 0) {
    showToast('Nothing to run — type some strings first.', 'info');
    return;
  }

  const availability = engineAvailability();
  if (!availability[state.engine].ready) {
    showToast(availability[state.engine].reason, 'warning', 6000);
    return;
  }

  const token = (runToken += 1);
  results = [];
  setRunning(true);
  renderProgress(0, strings.length);
  renderResults();

  const expectations = expectationMap();

  for (let i = 0; i < strings.length; i += 1) {
    // Cancelled, superseded by a newer run, or invalidated by a grammar edit.
    if (token !== runToken) return;

    results.push(runString(strings[i], expectations));
    renderProgress(i + 1, strings.length);
    renderResults();

    await yieldToBrowser();
  }

  if (token !== runToken) return;
  setRunning(false);
  renderProgress(strings.length, strings.length);
}

function cancelRun() {
  runToken += 1;
  setRunning(false);
}

function setRunning(running) {
  els.cancelButton.classList.toggle('d-none', !running);
  els.progressWrap.classList.toggle('d-none', !running && results.length === 0);
  els.runButton.disabled = running;
  els.runSavedButton.disabled = running;
  if (!running) {
    els.progressBar.classList.remove('progress-bar-animated');
    renderSavedButton();
    renderEngineChoice();
  } else {
    els.progressBar.classList.add('progress-bar-animated');
  }
}

/** string → the outcome the grammar's saved lists expect of it. */
function expectationMap() {
  const saved = savedTestStrings();
  const map = new Map();
  for (const value of saved.reject) map.set(value, 'reject');
  // Accept wins a contradiction, but the server refuses to save one at all.
  for (const value of saved.accept) map.set(value, 'accept');
  return map;
}

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */

function renderProgress(done, total) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  els.progressWrap.classList.remove('d-none');
  els.progressBar.style.width = `${percent}%`;
  els.progressBar.parentElement.setAttribute('aria-valuenow', String(percent));
  els.progressText.textContent = `${done} / ${total}`;
}

function renderResults() {
  if (results.length === 0) {
    els.results.innerHTML = `
      <p class="text-secondary mb-0">
        Results appear here. Click any row to open that string in the
        <a href="#cyk">Simulator</a>.
      </p>`;
    els.summary.textContent = '';
    return;
  }

  const rows = results.map((row, index) => renderRow(row, index)).join('');
  els.results.innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm align-middle batch-table mb-0">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">String</th>
            <th scope="col">Result</th>
            <th scope="col">Expected</th>
            <th scope="col">Match</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  for (const tr of els.results.querySelectorAll('[data-row-index]')) {
    tr.addEventListener('click', () => openInSimulator(Number(tr.dataset.rowIndex)));
  }

  renderSummary();
}

function renderRow(row, index) {
  const shown = row.input === '' ? EPSILON : row.input;

  let result;
  if (row.error) {
    result = '<span class="text-danger">could not run</span>';
  } else if (row.disagreement) {
    result = '<span class="text-danger fw-semibold">engines disagreed</span>';
  } else {
    result = row.accepted
      ? '<span class="batch-accepted">accepted</span>'
      : '<span class="batch-rejected">rejected</span>';
  }

  const expected = row.expected === null ? '<span class="text-secondary">—</span>' : row.expected;

  let match = '<span class="text-secondary">—</span>';
  if (row.matched === true) match = '<span class="batch-pass" aria-label="pass">✓</span>';
  if (row.matched === false) match = '<span class="batch-fail" aria-label="fail">✗</span>';

  const rowClass = row.matched === false || row.disagreement ? ' class="batch-row-failed"' : '';

  return `
    <tr${rowClass} data-row-index="${index}" role="button" tabindex="0"
        title="${escapeHtml(row.error || 'Open this string in the Simulator')}">
      <td class="text-secondary">${index + 1}</td>
      <td><code class="grammar-text">${escapeHtml(shown)}</code></td>
      <td>${result}</td>
      <td>${expected}</td>
      <td>${match}</td>
    </tr>`;
}

/**
 * The one-line verdict on the whole run.
 *
 * Strings with no saved expectation are counted separately rather than
 * silently passed: "7 / 8 passed" would be a lie if only three of them were
 * ever checked against anything.
 */
function renderSummary() {
  const checked = results.filter((row) => row.matched !== null);
  const passed = checked.filter((row) => row.matched === true).length;

  const parts = [];
  if (checked.length > 0) {
    parts.push(
      `<span class="${passed === checked.length ? 'batch-pass' : 'batch-fail'} fw-semibold">` +
        `${passed} / ${checked.length} passed</span>`
    );
  }

  const unchecked = results.filter((row) => row.matched === null);
  if (unchecked.length > 0) {
    // Counted over the unchecked rows ALONE. Totalling every row here would
    // read as a breakdown of the very strings this clause is about, and
    // quietly overstate both numbers.
    const accepted = unchecked.filter((row) => row.accepted === true).length;
    const rejected = unchecked.filter((row) => row.accepted === false).length;
    parts.push(
      `<span class="text-secondary">${unchecked.length} with no saved expectation ` +
        `(${accepted} accepted, ${rejected} rejected)</span>`
    );
  }

  const failedToRun = results.filter((row) => row.error !== null).length;
  if (failedToRun > 0) {
    parts.push(
      `<span class="batch-fail">${failedToRun} could not run</span>`
    );
  }

  els.summary.innerHTML = parts.join(' · ');
}

/**
 * Open one row's string in the simulator, animation and all.
 *
 * Navigating FIRST matters: showSection lays the section out, and the CYK
 * table needs real dimensions to render into. The request then travels over
 * the shared event bus rather than by importing the simulator here, so the
 * two views stay independent of one another.
 *
 * @param {number} index Position in `results`.
 */
function openInSimulator(index) {
  const row = results[index];
  if (!row) return;
  navigateTo('cyk');
  emit('simulate-request', { input: row.input });
}
