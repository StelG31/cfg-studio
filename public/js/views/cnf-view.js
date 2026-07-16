/**
 * public/js/views/cnf-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The "CNF Conversion" section: shows the current working grammar, runs
 *   the shared converter (core/cnf.js) CLIENT-SIDE for instant feedback,
 *   and renders the full pedagogical trace:
 *
 *     original grammar → six explained stages (with per-change reasons and
 *     an expandable grammar snapshot after every stage) → final CNF grammar.
 *
 *   The conversion result is published as state.cnf ('cnf-computed' event)
 *   so the CYK simulator can pick it up directly.
 *
 * DOM contract (views/index.html):  #cnfSource #btnConvertCnf #cnfResults
 */

import { convertToCnf } from '/core/cnf.js';
import { validateGrammar } from '/core/validator.js';
import { state, events, emit, navigateTo } from '../app.js';
import { escapeHtml, showToast } from '../ui.js';
import { grammarHtml, productionHtml } from '../grammar-render.js';

const els = {};

export function init() {
  els.source = document.getElementById('cnfSource');
  els.convertButton = document.getElementById('btnConvertCnf');
  els.results = document.getElementById('cnfResults');

  els.convertButton.addEventListener('click', convert);

  // Any grammar edit invalidates a previous conversion (app.js already
  // cleared state.cnf) — reflect that in the DOM the next time we render.
  // Deliberate trade-off: this re-renders on EVERY editor keystroke, even
  // while this section is hidden. The work is trivial at classroom scale,
  // and rendering eagerly means the panel can never be stale when shown.
  events.addEventListener('grammar-changed', renderAll);
  events.addEventListener('grammar-loaded', renderAll);
  events.addEventListener('section-shown', (event) => {
    if (event.detail?.name === 'cnf') renderAll();
  });

  renderAll();
}

/* ------------------------------------------------------------------------ */
/* Actions                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Run the conversion on the working grammar (client-side — instant, no
 * round-trip), publish state.cnf + 'cnf-computed' for the CYK view, and
 * render the full trace. Invalid grammars are refused with a toast BEFORE
 * calling the converter, so its internal throw stays a never-hit safety net.
 */
function convert() {
  const grammar = state.grammar;
  const { valid, errors } = validateGrammar(grammar);
  if (!valid) {
    showToast(
      `The grammar has ${errors.length} validation error${errors.length === 1 ? '' : 's'} — ` +
        'fix them in the editor before converting.',
      'danger',
      6000
    );
    return;
  }

  try {
    state.cnf = convertToCnf(grammar);
  } catch (err) {
    showToast(`Conversion failed: ${err.message}`, 'danger', 6000);
    return;
  }

  emit('cnf-computed');
  renderAll();
  showToast(
    state.cnf.alreadyCnf
      ? 'The grammar is already in Chomsky Normal Form.'
      : 'Conversion complete — every step is explained below.',
    'success'
  );
}

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */

function renderAll() {
  renderSource();
  renderResults();
}

/**
 * The "Source grammar" card: empty-state hint, or the grammar display plus
 * a warning (and a disabled Convert button) when validation fails —
 * the button's disabled state and the warning always agree because both
 * derive from the same validateGrammar call.
 */
function renderSource() {
  const grammar = state.grammar;
  if (!grammar || grammar.productions.length === 0) {
    els.source.innerHTML =
      '<p class="text-secondary mb-0">No grammar yet — define one in the ' +
      '<a href="#editor">editor</a> or load a sample from <a href="#grammars">My Grammars</a>.</p>';
    els.convertButton.disabled = true;
    return;
  }

  const { valid, errors } = validateGrammar(grammar);
  els.convertButton.disabled = !valid;

  els.source.innerHTML = `
    ${grammarHtml(grammar)}
    ${
      valid
        ? ''
        : `<div class="alert alert-warning small mt-3 mb-0">
             <i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>
             This grammar has ${errors.length} validation error${errors.length === 1 ? '' : 's'} —
             fix them in the <a href="#editor" class="alert-link">editor</a> before converting.
           </div>`
    }`;
}

/**
 * One change entry (add / remove / replace) inside a step card.
 *
 * `grammar` is the POST-stage snapshot on purpose: a variable introduced
 * by this very stage (e.g. T_a) must already colour as a variable in the
 * change line that introduces it.
 *
 * @param {object} change  A typed change entry from core/cnf.js.
 * @param {object} grammar The step's grammar snapshot (for colouring).
 * @returns {string} HTML list item.
 */
function changeHtml(change, grammar) {
  if (change.type === 'add') {
    return `
      <li class="cnf-change">
        <i class="bi bi-plus-circle-fill text-success" aria-hidden="true"></i>
        <span class="grammar-text">${productionHtml(change.production, grammar)}</span>
        <div class="small text-secondary">${escapeHtml(change.reason)}</div>
      </li>`;
  }
  if (change.type === 'remove') {
    return `
      <li class="cnf-change">
        <i class="bi bi-dash-circle-fill text-danger" aria-hidden="true"></i>
        <span class="grammar-text cnf-removed">${productionHtml(change.production, grammar)}</span>
        <div class="small text-secondary">${escapeHtml(change.reason)}</div>
      </li>`;
  }
  // replace
  return `
    <li class="cnf-change">
      <i class="bi bi-arrow-repeat text-primary" aria-hidden="true"></i>
      <span class="grammar-text">
        <span class="cnf-removed">${productionHtml(change.before, grammar)}</span>
        <span class="arrow mx-1">⇒</span>
        ${productionHtml(change.after, grammar)}
      </span>
      <div class="small text-secondary">${escapeHtml(change.reason)}</div>
    </li>`;
}

function stepHtml(step, index) {
  const changeCount = step.changes.length;
  const badge =
    changeCount === 0
      ? '<span class="badge text-bg-light border">no change</span>'
      : `<span class="badge text-bg-primary">${changeCount} change${changeCount === 1 ? '' : 's'}</span>`;

  return `
    <div class="accordion-item">
      <h3 class="accordion-header">
        <button class="accordion-button ${index === 0 ? '' : 'collapsed'}" type="button"
                data-bs-toggle="collapse" data-bs-target="#cnfStep${index}"
                aria-expanded="${index === 0}" aria-controls="cnfStep${index}">
          <span class="me-2 text-secondary">${index + 1}.</span>
          <span class="fw-semibold me-2">${escapeHtml(step.title)}</span>
          ${badge}
        </button>
      </h3>
      <div id="cnfStep${index}" class="accordion-collapse collapse ${index === 0 ? 'show' : ''}"
           data-bs-parent="#cnfStepsAccordion">
        <div class="accordion-body">
          <p class="mb-3">${escapeHtml(step.explanation)}</p>
          ${
            step.changes.length > 0
              ? `<ul class="list-unstyled cnf-change-list mb-3">
                   ${step.changes.map((c) => changeHtml(c, step.grammar)).join('')}
                 </ul>`
              : ''
          }
          <details>
            <summary class="small text-secondary">Grammar after this stage
              (${step.grammar.productions.length} productions)</summary>
            <div class="mt-2 p-3 bg-light rounded">${grammarHtml(step.grammar)}</div>
          </details>
        </div>
      </div>
    </div>`;
}

/**
 * The results area: nothing (no conversion yet), an "already CNF" notice,
 * or the six-step accordion plus the final-CNF card. The "Use in CYK"
 * button is disabled when L(G) = ∅ — there is nothing for CYK to accept.
 */
function renderResults() {
  const conversion = state.cnf;
  if (!conversion) {
    els.results.innerHTML = '';
    return;
  }

  const { steps, result, alreadyCnf, emptyLanguage } = conversion;

  els.results.innerHTML = `
    ${
      alreadyCnf
        ? `<div class="alert alert-info">
             <i class="bi bi-info-circle me-1" aria-hidden="true"></i>
             ${escapeHtml(steps[0].explanation)}
           </div>`
        : `<div class="card mb-4">
             <div class="card-header">
               <i class="bi bi-list-ol me-2" aria-hidden="true"></i>Conversion steps
             </div>
             <div class="card-body p-0">
               <div class="accordion accordion-flush" id="cnfStepsAccordion">
                 ${steps.map(stepHtml).join('')}
               </div>
             </div>
           </div>`
    }

    <div class="card border-success-subtle">
      <div class="card-header d-flex align-items-center justify-content-between flex-wrap gap-2">
        <span><i class="bi bi-check2-circle me-2 text-success" aria-hidden="true"></i>
          Resulting CNF grammar</span>
        <button type="button" class="btn btn-sm btn-primary" id="btnUseInCyk"
                ${emptyLanguage ? 'disabled' : ''}>
          <i class="bi bi-grid-3x3" aria-hidden="true"></i> Use in CYK simulator
        </button>
      </div>
      <div class="card-body">
        ${
          emptyLanguage
            ? `<div class="alert alert-warning mb-3">
                 <i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>
                 The start symbol cannot derive any terminal string:
                 <strong>L(G) = ∅</strong>. There is nothing for CYK to accept.
               </div>`
            : ''
        }
        ${grammarHtml(result)}
        <hr>
        <div class="small text-secondary">
          |V| = ${result.variables.length} · |Σ| = ${result.terminals.length} ·
          |P| = ${result.productions.length} · start:
          <span class="sym sym-variable">${escapeHtml(result.startSymbol)}</span>
        </div>
      </div>
    </div>`;

  document.getElementById('btnUseInCyk')?.addEventListener('click', () => navigateTo('cyk'));
}
