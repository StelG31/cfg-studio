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
import { validateGrammar } from '/core/validator.js';
import { serializeGrammar } from '/core/grammar.js';
import {
  state,
  events,
  markGrammarEdited,
  markGrammarSaved,
  setGrammar,
  setDirty,
} from '../app.js';
import { escapeHtml, showToast, confirmDialog, setLoading, initTooltips } from '../ui.js';
import { saveDraft, loadDraft, clearDraft, api, downloadGrammarFile } from '../storage.js';
import { symbolHtml, grammarHtml } from '../grammar-render.js';

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

/**
 * True while a save request is in flight.
 *
 * A save POSTs a new document whenever grammarId is still null, so two
 * overlapping runs create two documents — and the second one is invisible
 * until the list is next refreshed. Both triggers can repeat faster than the
 * request returns: a double-click on Save, and holding Ctrl+S, where key
 * repeat fires the handler over and over.
 */
let saving = false;

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
  els.saveButton = document.getElementById('btnSaveGrammar');
  els.overview = document.getElementById('grammarOverview');
  els.validation = document.getElementById('validationPanel');

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

  els.saveButton.addEventListener('click', saveGrammar);
  document.getElementById('btnExportGrammar').addEventListener('click', exportGrammar);

  // Ctrl+S / Cmd+S saves the working grammar from anywhere in the app.
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveGrammar();
    }
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
  renderValidation();
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
  renderValidation();
  // Keep the draft in sync so a reload restores the freshly loaded grammar.
  scheduleDraftSave();
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
  // Restored alongside the id: a reload must not turn a borrowed grammar into
  // one of unknown origin, or the copy-on-save would go unexplained exactly
  // when the reader has lost the context that would have explained it.
  state.borrowedFrom = draft.borrowedFrom ?? null;

  refreshSymbolSelects();
  els.start.value = draft.startSymbol ?? '';
  renderRows();
  rebuildGrammar();
  // rebuildGrammar marks the grammar dirty; restore the flag the draft
  // actually had (a freshly loaded grammar reloads as clean).
  setDirty(draft.dirty ?? true);
}

/* ------------------------------------------------------------------------ */
/* Production rows (dynamic DOM)                                             */
/* ------------------------------------------------------------------------ */

/** Append a blank row, pre-selecting the first declared variable as LHS. */
function addRow() {
  const variables = splitVariables(els.variables.value);
  rows.push({ left: variables[0] ?? '', rhsText: '', errors: [] });
  renderRows();
  rebuildGrammar();
}

/**
 * Delete a row by index. The editor never shows zero rows — an empty
 * placeholder row is re-inserted so "Add production" isn't the only way
 * back after deleting everything.
 *
 * @param {number} index Position in `rows` (indices are re-assigned by the
 *                       full re-render that follows, so no staleness).
 */
function removeRow(index) {
  rows.splice(index, 1);
  if (rows.length === 0) rows.push({ left: '', rhsText: '', errors: [] });
  renderRows();
  rebuildGrammar();
}

/** Put the keyboard cursor into the RHS input of row `index`. */
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

/**
 * Rebuild the start-symbol dropdown from the declared variables, keeping
 * the previous choice when it is still declared (so retyping the variable
 * list doesn't silently drop the user's selection).
 *
 * @param {string[]} variables Currently declared variable names.
 */
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

/**
 * (Re)populate one row's LHS dropdown. A row may reference a variable the
 * user has (temporarily) deleted from the declaration list — that value is
 * kept selectable, visibly marked "(undeclared)", so no production text is
 * ever silently lost while the user reorganises their symbols.
 *
 * @param {HTMLSelectElement} select The row's LHS <select>.
 * @param {string} current           The row's current LHS value.
 * @param {string[]} [variables]     Declared variables (parsed if omitted).
 */
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

/**
 * Repaint the "Grammar overview" panel: symbol chips (start symbol gets a
 * halo), the grouped textbook-style production display (shared renderer),
 * and the |V|/|Σ|/|P| summary line. Called on every model change.
 */
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
    ${grammarHtml(grammar)}
    <hr>
    <div class="small text-secondary">
      |V| = ${grammar.variables.length} · |Σ| = ${grammar.terminals.length} ·
      |P| = ${grammar.productions.length} · start: ${
        grammar.startSymbol ? symbolHtml(grammar.startSymbol, grammar) : '<em>not set</em>'
      }
    </div>`;

  initTooltips(els.overview);
}

/* ------------------------------------------------------------------------ */
/* Validation panel (live feedback from core/validator.js)                   */
/* ------------------------------------------------------------------------ */

/** One finding → one list row with a severity icon. */
function findingHtml(finding) {
  const isError = finding.severity === 'error';
  const icon = isError ? 'bi-x-circle-fill text-danger' : 'bi-exclamation-triangle-fill text-warning';
  return `
    <li class="d-flex gap-2 align-items-start mb-2">
      <i class="bi ${icon} mt-1" aria-hidden="true"></i>
      <span>${escapeHtml(finding.message)}</span>
    </li>`;
}

/**
 * Re-run the shared validator against the working grammar and paint the
 * result. Runs on every model change — the analyses are linear-time, so
 * live validation costs nothing at classroom scale.
 */
function renderValidation() {
  const grammar = state.grammar;
  if (!grammar) return;

  const isUntouched =
    grammar.variables.length === 0 &&
    grammar.terminals.length === 0 &&
    grammar.productions.length === 0;
  if (isUntouched) {
    els.validation.innerHTML =
      '<p class="text-secondary mb-0">Validation results will appear here as you type.</p>';
    return;
  }

  const { valid, errors, warnings } = validateGrammar(grammar);

  const parts = [];
  if (valid) {
    parts.push(`
      <div class="verdict-banner verdict-accepted mb-0">
        <i class="bi bi-check-circle-fill" aria-hidden="true"></i>
        The grammar is well-formed.
      </div>`);
  } else {
    parts.push(`
      <div class="verdict-banner verdict-rejected mb-3">
        <i class="bi bi-x-circle-fill" aria-hidden="true"></i>
        ${errors.length} problem${errors.length === 1 ? '' : 's'} to fix
      </div>
      <ul class="list-unstyled small mb-0">${errors.map(findingHtml).join('')}</ul>`);
  }

  if (warnings.length > 0) {
    parts.push(`
      <hr>
      <p class="small text-secondary mb-2">
        Warnings — the grammar is usable, but contains useless structure:
      </p>
      <ul class="list-unstyled small mb-0">${warnings.map(findingHtml).join('')}</ul>`);
  }

  els.validation.innerHTML = parts.join('');
}

/* ------------------------------------------------------------------------ */
/* Save / export actions                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Persist the working grammar on the server. Only valid grammars are
 * accepted (the server enforces the same rule with the same validator —
 * this early client check just gives faster feedback).
 */
async function saveGrammar() {
  // The flag is the guard, not the disabled button: Ctrl+S never touches the
  // button, so disabling it alone would leave the keyboard path unprotected.
  if (saving) return;

  const grammar = state.grammar;
  const { valid, errors } = validateGrammar(grammar);
  if (!valid) {
    showToast(
      `Cannot save: the grammar has ${errors.length} validation error${errors.length === 1 ? '' : 's'}. ` +
        'Fix the problems shown in the validation panel first.',
      'danger',
      6000
    );
    return;
  }

  // Read before saving: markGrammarSaved() clears it, and this is the one
  // moment the fact is worth reporting.
  const borrowedFrom = state.borrowedFrom;

  saving = true;
  els.saveButton.disabled = true; // the guard, made visible
  setLoading(true, 'Saving grammar…');
  try {
    if (state.grammarId) {
      await api.updateGrammar(state.grammarId, grammar);
      showToast(`Updated "${grammar.name}".`, 'success');
    } else {
      const doc = await api.createGrammar(grammar);
      markGrammarSaved(doc.id);
      // A copy-on-save is silent otherwise: the grammar came from somebody
      // else's list, so "Saved" alone would leave the reader unsure whether
      // they had just written over it.
      showToast(
        borrowedFrom
          ? `Saved as your own copy — ${borrowedFrom}'s original was not modified.`
          : `Saved "${grammar.name}".`,
        'success',
        borrowedFrom ? 7000 : undefined
      );
    }
    markGrammarSaved(state.grammarId);
    scheduleDraftSave(); // persist the clean state (id + dirty=false)
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'danger', 6000);
  } finally {
    // finally, not the success path: a failed save must leave Save usable, or
    // one network blip strands the grammar in the editor with no way out.
    setLoading(false);
    els.saveButton.disabled = false;
    saving = false;
  }
}

/** Download the working grammar as a JSON file (allowed even mid-edit). */
function exportGrammar() {
  downloadGrammarFile(state.grammar, serializeGrammar(state.grammar));
  showToast('Grammar exported as JSON.', 'success');
}

/* ------------------------------------------------------------------------ */
/* Draft autosave                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Debounced (400 ms) draft persistence. The snapshot stores the VERBATIM
 * form state — not the parsed grammar — so half-typed, not-yet-parseable
 * text survives a reload too. Draft snapshot shape:
 *
 *   { name, description,            // metadata inputs, as typed
 *     variablesText, terminalsText, // raw declaration inputs, as typed
 *     startSymbol,                  // current dropdown value
 *     rows: [{left, rhsText}],      // production lines, as typed
 *     grammarId,                    // server id if the grammar was saved
 *     borrowedFrom,                 // owner it was opened from, if not ours
 *     dirty }                       // unsaved flag, restored verbatim
 */
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
      borrowedFrom: state.borrowedFrom,
      dirty: state.dirty,
    });
  }, 400);
}
