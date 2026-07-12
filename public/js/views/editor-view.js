/**
 * public/js/views/editor-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The Grammar Editor section: lets the user define the 4-tuple
 *   G = (V, Σ, P, S) through friendly form controls and keeps the shared
 *   application state (app.js) in sync on every keystroke.
 *
 *   Responsibilities:
 *     - dynamic production rows (add / remove / edit, per-row ε button),
 *     - turning raw form text into a grammar object via core/grammar.js,
 *     - precise per-row parse feedback (unknown symbols, bad syntax),
 *     - the live "Grammar overview" panel (symbol chips + rendered grammar),
 *     - draft autosave to localStorage so work survives reloads.
 *
 *   The editor NEVER validates semantics (undefined variables, missing
 *   start symbol, ...) — that is validator.js's job, rendered in the
 *   validation panel. Here we only deal with *form → model* translation.
 *
 * DOM contract (views/index.html):
 *   #grammarName #grammarDescription #variablesInput #terminalsInput
 *   #startSymbolSelect #productionRows #btnAddProduction #btnNewGrammar
 *   #grammarOverview
 */

import {
  createEmptyGrammar,
  createGrammar,
  parseProductionLine,
  EPSILON,
} from '/core/grammar.js';
import { state, events, markGrammarEdited, setGrammar } from '../app.js';
import { escapeHtml, showToast, confirmDialog, initTooltips } from '../ui.js';
import { saveDraft, loadDraft, clearDraft } from '../storage.js';

/* ------------------------------------------------------------------------ */
/* Module state                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The editor's working representation: one row per production LINE
 * (a variable plus its alternatives as raw text). The flat production list
 * of the grammar object is derived from these rows on every change.
 * @type {{left: string, rhsText: string, errors: string[]}[]}
 */
let rows = [];

/** Cached element references, filled once in init(). */
const els = {};

let draftTimer = null;

/* ------------------------------------------------------------------------ */
/* Initialisation                                                            */
/* ------------------------------------------------------------------------ */

export function init() {
  els.name = document.getElementById('grammarName');
  els.description = document.getElementById('grammarDescription');
  els.variables = document.getElementById('variablesInput');
  els.terminals = document.getElementById('terminalsInput');
  els.start = document.getElementById('startSymbolSelect');
  els.rowsContainer = document.getElementById('productionRows');
  els.addButton = document.getElementById('btnAddProduction');
  els.newButton = document.getElementById('btnNewGrammar');
  els.overview = document.getElementById('grammarOverview');

  // Form fields → model (metadata fields don't affect symbols/productions).
  els.name.addEventListener('input', rebuildGrammar);
  els.description.addEventListener('input', rebuildGrammar);
  els.variables.addEventListener('input', () => {
    refreshSymbolSelects();
    rebuildGrammar();
  });
  els.terminals.addEventListener('input', rebuildGrammar);
  els.start.addEventListener('change', rebuildGrammar);

  els.addButton.addEventListener('click', () => {
    addRow();
    focusRow(rows.length - 1);
  });

  els.newButton.addEventListener('click', async () => {
    if (state.dirty) {
      const confirmed = await confirmDialog({
        title: 'Start a new grammar?',
        message: 'Your current grammar has unsaved changes that will be lost.',
        confirmText: 'Discard and start new',
      });
      if (!confirmed) return;
    }
    clearDraft();
    setGrammar(createEmptyGrammar());
    showToast('Started a new blank grammar.', 'info');
  });

  // Another view (My Grammars, samples, import) replaced the working grammar.
  events.addEventListener('grammar-loaded', fillFormFromGrammar);

  // First paint: restore the last draft if one exists, otherwise start blank.
  const draft = loadDraft();
  if (draft && typeof draft === 'object') {
    applyDraft(draft);
    showToast('Restored your unsaved draft from the last session.', 'info');
  } else {
    setGrammar(createEmptyGrammar());
  }
}

/* ------------------------------------------------------------------------ */
/* Reading the form: text inputs → symbol lists                              */
/* ------------------------------------------------------------------------ */

/** Variables never contain commas, so commas and whitespace both separate. */
function splitVariables(text) {
  return text.split(/[,\s]+/).filter(Boolean);
}

/**
 * Terminals are separated by whitespace. A trailing comma is forgiven
 * ("a, b" → a b) — but a lone "," stays a comma, because the comma itself
 * is a perfectly legal terminal symbol.
 */
function splitTerminals(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => (token.length > 1 ? token.replace(/,+$/, '') : token))
    .filter(Boolean);
}

/* ------------------------------------------------------------------------ */
/* Model synchronisation (form → state.grammar)                              */
/* ------------------------------------------------------------------------ */

/**
 * Rebuild state.grammar from the current form contents. Called on every
 * relevant input event. Rows that fail to parse are flagged inline and
 * simply excluded from the model until fixed — the rest of the app always
 * sees a structurally sound grammar.
 */
function rebuildGrammar() {
  const variables = splitVariables(els.variables.value);
  const terminals = splitTerminals(els.terminals.value);
  const declared = { variables, terminals };

  const productions = [];
  for (const row of rows) {
    row.errors = [];
    if (row.left === '' || row.rhsText.trim() === '') continue; // untouched row
    const result = parseProductionLine(`${row.left} -> ${row.rhsText}`, declared);
    if (result.ok) {
      productions.push(...result.productions);
    } else {
      row.errors = result.errors;
    }
  }

  state.grammar = createGrammar({
    name: els.name.value,
    description: els.description.value,
    variables,
    terminals,
    startSymbol: els.start.value,
    productions,
  });

  markGrammarEdited();
  renderRowFeedback();
  renderOverview();
  scheduleDraftSave();
}

/* ------------------------------------------------------------------------ */
/* Filling the form (state.grammar → form)                                   */
/* ------------------------------------------------------------------------ */

/** Group a flat production list back into editor rows (one per variable line). */
function grammarToRows(grammar) {
  const byLeft = new Map();
  for (const production of grammar.productions) {
    if (!byLeft.has(production.left)) byLeft.set(production.left, []);
    byLeft
      .get(production.left)
      .push(production.right.length === 0 ? EPSILON : production.right.join(' '));
  }
  return [...byLeft.entries()].map(([left, alternatives]) => ({
    left,
    rhsText: alternatives.join(' | '),
    errors: [],
  }));
}

/** Populate every form control from state.grammar (on load/import/new). */
function fillFormFromGrammar() {
  const grammar = state.grammar;
  els.name.value = grammar.name === 'Untitled grammar' ? '' : grammar.name;
  els.description.value = grammar.description;
  els.variables.value = grammar.variables.join(' ');
  els.terminals.value = grammar.terminals.join(' ');

  rows = grammarToRows(grammar);
  if (rows.length === 0) rows.push({ left: grammar.startSymbol || '', rhsText: '', errors: [] });

  refreshSymbolSelects();
  els.start.value = grammar.startSymbol;
  renderRows();
  renderOverview();
}

/** Restore the verbatim form snapshot saved as a draft. */
function applyDraft(draft) {
  els.name.value = draft.name ?? '';
  els.description.value = draft.description ?? '';
  els.variables.value = draft.variablesText ?? '';
  els.terminals.value = draft.terminalsText ?? '';

  rows = Array.isArray(draft.rows)
    ? draft.rows.map((row) => ({
        left: String(row.left ?? ''),
        rhsText: String(row.rhsText ?? ''),
        errors: [],
      }))
    : [];
  if (rows.length === 0) rows.push({ left: '', rhsText: '', errors: [] });

  state.grammarId = draft.grammarId ?? null;

  refreshSymbolSelects();
  els.start.value = draft.startSymbol ?? '';
  renderRows();
  rebuildGrammar();
}

/* ------------------------------------------------------------------------ */
/* Production rows (dynamic DOM)                                             */
/* ------------------------------------------------------------------------ */

function addRow() {
  const variables = splitVariables(els.variables.value);
  rows.push({ left: variables[0] ?? '', rhsText: '', errors: [] });
  renderRows();
  rebuildGrammar();
}

function removeRow(index) {
  rows.splice(index, 1);
  if (rows.length === 0) rows.push({ left: '', rhsText: '', errors: [] });
  renderRows();
  rebuildGrammar();
}

function focusRow(index) {
  els.rowsContainer.querySelectorAll('.rhs-input')[index]?.focus();
}

/**
 * Full re-render of the row DOM. Only called on STRUCTURAL changes
 * (add/remove/load) — per-keystroke updates touch existing nodes only,
 * so typing never loses focus.
 */
function renderRows() {
  els.rowsContainer.innerHTML = '';
  rows.forEach((row, index) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'production-row';
    rowEl.dataset.index = String(index);
    rowEl.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <select class="form-select form-select-sm lhs-select grammar-input"
                aria-label="Left-hand side variable"></select>
        <span class="arrow" aria-hidden="true">→</span>
        <input type="text" class="form-control form-control-sm rhs-input grammar-input"
               placeholder="e.g.  a S b | ε" value="${escapeHtml(row.rhsText)}"
               aria-label="Right-hand side alternatives" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-outline-secondary btn-sm eps-btn"
                title="Insert ε (empty string)" tabindex="-1">ε</button>
        <button type="button" class="btn btn-outline-danger btn-sm remove-btn"
                title="Delete this production line">
          <i class="bi bi-trash" aria-hidden="true"></i>
        </button>
      </div>
      <div class="row-error small text-danger mt-1"></div>`;

    const lhsSelect = rowEl.querySelector('.lhs-select');
    const rhsInput = rowEl.querySelector('.rhs-input');

    fillLhsSelect(lhsSelect, row.left);

    lhsSelect.addEventListener('change', () => {
      row.left = lhsSelect.value;
      rebuildGrammar();
    });
    rhsInput.addEventListener('input', () => {
      row.rhsText = rhsInput.value;
      rebuildGrammar();
    });
    rowEl.querySelector('.eps-btn').addEventListener('click', () => {
      insertAtCursor(rhsInput, EPSILON);
      row.rhsText = rhsInput.value;
      rebuildGrammar();
    });
    rowEl.querySelector('.remove-btn').addEventListener('click', () => removeRow(index));

    els.rowsContainer.appendChild(rowEl);
  });

  renderRowFeedback();
}

/** Insert text at the cursor position of an input, keeping focus. */
function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.focus();
  input.selectionStart = input.selectionEnd = start + text.length;
}

/** Show/clear per-row parse errors without rebuilding the row DOM. */
function renderRowFeedback() {
  const rowEls = els.rowsContainer.querySelectorAll('.production-row');
  rowEls.forEach((rowEl, index) => {
    const row = rows[index];
    const errorEl = rowEl.querySelector('.row-error');
    const rhsInput = rowEl.querySelector('.rhs-input');
    if (row && row.errors.length > 0) {
      errorEl.textContent = row.errors.join(' ');
      rhsInput.classList.add('is-invalid');
    } else {
      errorEl.textContent = '';
      rhsInput?.classList.remove('is-invalid');
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Symbol <select> maintenance                                               */
/* ------------------------------------------------------------------------ */

/**
 * Refresh the start-symbol select and every row's LHS select in place
 * (options change as the user edits the variable list, values persist).
 */
function refreshSymbolSelects() {
  const variables = splitVariables(els.variables.value);

  fillStartSelect(variables);
  for (const rowEl of els.rowsContainer.querySelectorAll('.production-row')) {
    const row = rows[Number(rowEl.dataset.index)];
    if (row) fillLhsSelect(rowEl.querySelector('.lhs-select'), row.left, variables);
  }
}

function fillStartSelect(variables) {
  const previous = els.start.value;
  els.start.innerHTML = '<option value="">— choose a variable —</option>';
  for (const variable of variables) {
    const option = document.createElement('option');
    option.value = variable;
    option.textContent = variable;
    els.start.appendChild(option);
  }
  // Keep the previous choice when it is still declared.
  els.start.value = variables.includes(previous) ? previous : '';
}

function fillLhsSelect(select, current, variables = splitVariables(els.variables.value)) {
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '?';
  select.appendChild(placeholder);

  for (const variable of variables) {
    const option = document.createElement('option');
    option.value = variable;
    option.textContent = variable;
    select.appendChild(option);
  }
  // A row may reference a variable the user has (temporarily) removed:
  // keep it selectable but visibly marked, so no data silently disappears.
  if (current && !variables.includes(current)) {
    const orphan = document.createElement('option');
    orphan.value = current;
    orphan.textContent = `${current} (undeclared)`;
    select.appendChild(orphan);
  }
  select.value = current ?? '';
}

/* ------------------------------------------------------------------------ */
/* Grammar overview panel                                                    */
/* ------------------------------------------------------------------------ */

/** Render one symbol as a coloured chip. */
function chipHtml(symbol, kind, isStart = false) {
  const classes = `symbol-chip chip-${kind}${isStart ? ' chip-start' : ''}`;
  const startMark = isStart
    ? ' <i class="bi bi-play-fill" title="Start symbol" aria-hidden="true"></i>'
    : '';
  return `<span class="${classes}">${escapeHtml(symbol)}${startMark}</span>`;
}

/** Colour a right-hand side symbol by its kind for the grammar display. */
function coloredSymbol(symbol, grammar) {
  const kind = grammar.variables.includes(symbol) ? 'variable' : 'terminal';
  return `<span class="sym sym-${kind}">${escapeHtml(symbol)}</span>`;
}

function renderOverview() {
  const grammar = state.grammar;
  if (!grammar) return;

  const hasAnything =
    grammar.variables.length > 0 || grammar.terminals.length > 0 || grammar.productions.length > 0;
  if (!hasAnything) {
    els.overview.innerHTML =
      '<p class="text-secondary mb-0">Declare symbols and productions to see the grammar here.</p>';
    return;
  }

  // Group productions per variable for the classic textbook display.
  const byLeft = new Map();
  for (const production of grammar.productions) {
    if (!byLeft.has(production.left)) byLeft.set(production.left, []);
    byLeft.get(production.left).push(production.right);
  }

  const lines = [...byLeft.entries()].map(([left, alternatives]) => {
    const rhs = alternatives
      .map((right) =>
        right.length === 0
          ? `<span class="sym">${EPSILON}</span>`
          : right.map((symbol) => coloredSymbol(symbol, grammar)).join(' ')
      )
      .join(' <span class="arrow">|</span> ');
    return `<div>${coloredSymbol(left, grammar)} <span class="arrow">→</span> ${rhs}</div>`;
  });

  els.overview.innerHTML = `
    <div class="mb-2 small text-secondary">Variables (V)</div>
    <div class="mb-3">${
      grammar.variables.map((v) => chipHtml(v, 'variable', v === grammar.startSymbol)).join('') ||
      '<span class="text-secondary small">none</span>'
    }</div>
    <div class="mb-2 small text-secondary">Terminals (Σ)</div>
    <div class="mb-3">${
      grammar.terminals.map((t) => chipHtml(t, 'terminal')).join('') ||
      '<span class="text-secondary small">none</span>'
    }</div>
    <div class="mb-2 small text-secondary">Productions (P)</div>
    <div class="grammar-display">${lines.join('') || '<span class="text-secondary small">none</span>'}</div>
    <hr>
    <div class="small text-secondary">
      |V| = ${grammar.variables.length} · |Σ| = ${grammar.terminals.length} ·
      |P| = ${grammar.productions.length} · start: ${
        grammar.startSymbol
          ? `<span class="sym sym-variable">${escapeHtml(grammar.startSymbol)}</span>`
          : '<em>not set</em>'
      }
    </div>`;

  initTooltips(els.overview);
}

/* ------------------------------------------------------------------------ */
/* Draft autosave                                                            */
/* ------------------------------------------------------------------------ */

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    saveDraft({
      name: els.name.value,
      description: els.description.value,
      variablesText: els.variables.value,
      terminalsText: els.terminals.value,
      startSymbol: els.start.value,
      rows: rows.map(({ left, rhsText }) => ({ left, rhsText })),
      grammarId: state.grammarId,
    });
  }, 400);
}
