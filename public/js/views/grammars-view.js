/**
 * public/js/views/grammars-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The "My Grammars" section:
 *     - lists grammars saved on the server (load / export / delete),
 *     - shows the built-in sample grammars with one-click loading,
 *     - imports grammars from JSON files.
 *
 *   All transport goes through storage.js; all grammar-shape knowledge
 *   comes from core/grammar.js. This module only renders and orchestrates.
 *
 * DOM contract (views/index.html):
 *   #savedGrammarsList #sampleGrammarsList #btnImportGrammar #importFileInput
 */

import { createGrammar, deserializeGrammar, grammarToText } from '/core/grammar.js';
import { state, events, setGrammar, navigateTo } from '../app.js';
import { escapeHtml, showToast, confirmDialog, setLoading, initTooltips } from '../ui.js';
import { api, readFileText, clearDraft } from '../storage.js';

const els = {};

export function init() {
  els.savedList = document.getElementById('savedGrammarsList');
  els.sampleList = document.getElementById('sampleGrammarsList');
  els.importButton = document.getElementById('btnImportGrammar');
  els.fileInput = document.getElementById('importFileInput');

  els.importButton.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', onImportFile);

  // Refresh the saved list every time the section becomes visible — cheap,
  // and it keeps the list in sync after saves made in the editor.
  events.addEventListener('section-shown', (event) => {
    if (event.detail?.name === 'grammars') refreshSaved();
  });

  refreshSaved();
  renderSamples();
}

/* ------------------------------------------------------------------------ */
/* Loading a grammar into the editor (shared by saved/sample/import paths)   */
/* ------------------------------------------------------------------------ */

/**
 * Make `grammar` the working grammar. Replaces the editor draft: loading is
 * an explicit user decision, so the previous draft has been superseded.
 */
function loadIntoEditor(grammar, { id = null, sourceLabel }) {
  clearDraft();
  setGrammar(createGrammar(grammar), { id });
  navigateTo('editor');
  showToast(`Loaded ${sourceLabel}.`, 'success');
}

/* ------------------------------------------------------------------------ */
/* Saved grammars                                                            */
/* ------------------------------------------------------------------------ */

async function refreshSaved() {
  try {
    const list = await api.listGrammars();
    renderSaved(list);
  } catch (err) {
    els.savedList.innerHTML = `<p class="text-danger mb-0">Could not load saved grammars: ${escapeHtml(err.message)}</p>`;
  }
}

function renderSaved(list) {
  if (list.length === 0) {
    els.savedList.innerHTML = `
      <div class="text-center text-secondary py-4">
        <i class="bi bi-folder2-open fs-2 d-block mb-2" aria-hidden="true"></i>
        No saved grammars yet — build one in the editor and press <strong>Save</strong>.
      </div>`;
    return;
  }

  els.savedList.innerHTML = `
    <ul class="list-group list-group-flush saved-grammar-list">
      ${list
        .map(
          (doc) => `
        <li class="list-group-item px-0 d-flex justify-content-between align-items-start gap-2 flex-wrap">
          <div class="me-auto">
            <div class="fw-semibold">${escapeHtml(doc.name)}</div>
            ${doc.description ? `<div class="small text-secondary">${escapeHtml(doc.description)}</div>` : ''}
            <div class="small text-secondary">
              |V| = ${doc.variableCount} · |Σ| = ${doc.terminalCount} · |P| = ${doc.productionCount}
              · updated ${escapeHtml(new Date(doc.updatedAt).toLocaleString())}
            </div>
          </div>
          <div class="btn-group btn-group-sm" role="group" aria-label="Actions for ${escapeHtml(doc.name)}">
            <button type="button" class="btn btn-outline-primary" data-action="load" data-id="${doc.id}">
              <i class="bi bi-box-arrow-in-left" aria-hidden="true"></i> Load
            </button>
            <button type="button" class="btn btn-outline-secondary" data-action="export" data-id="${doc.id}"
                    title="Download as JSON">
              <i class="bi bi-download" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-outline-danger" data-action="delete" data-id="${doc.id}"
                    data-name="${escapeHtml(doc.name)}" title="Delete">
              <i class="bi bi-trash" aria-hidden="true"></i>
            </button>
          </div>
        </li>`
        )
        .join('')}
    </ul>`;

  els.savedList.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => onSavedAction(button));
  });
}

async function onSavedAction(button) {
  const { action, id, name } = button.dataset;

  if (action === 'load') {
    setLoading(true, 'Loading grammar…');
    try {
      const doc = await api.getGrammar(id);
      loadIntoEditor(doc, { id: doc.id, sourceLabel: `"${doc.name}"` });
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  }

  if (action === 'export') {
    try {
      const doc = await api.getGrammar(id);
      const { downloadGrammarFile } = await import('../storage.js');
      const { serializeGrammar } = await import('/core/grammar.js');
      downloadGrammarFile(doc, serializeGrammar(createGrammar(doc)));
      showToast('Grammar exported as JSON.', 'success');
    } catch (err) {
      showToast(err.message, 'danger');
    }
  }

  if (action === 'delete') {
    const confirmed = await confirmDialog({
      title: 'Delete grammar?',
      message: `"${name}" will be permanently removed from the server.`,
      confirmText: 'Delete',
    });
    if (!confirmed) return;

    setLoading(true, 'Deleting…');
    try {
      await api.deleteGrammar(id);
      if (state.grammarId === id) state.grammarId = null; // it no longer exists server-side
      showToast(`Deleted "${name}".`, 'success');
      await refreshSaved();
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Sample grammars                                                           */
/* ------------------------------------------------------------------------ */

async function renderSamples() {
  let samples;
  try {
    samples = await api.listExamples();
  } catch (err) {
    els.sampleList.innerHTML = `<p class="text-danger mb-0">Could not load samples: ${escapeHtml(err.message)}</p>`;
    return;
  }

  els.sampleList.innerHTML = samples
    .map(
      (sample) => `
      <div class="sample-card border rounded p-3 mb-3">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div>
            <div class="fw-semibold">${escapeHtml(sample.name)}</div>
            <div class="small text-secondary mb-2">${escapeHtml(sample.description)}</div>
          </div>
          <button type="button" class="btn btn-sm btn-outline-primary flex-shrink-0"
                  data-sample-id="${escapeHtml(sample.id)}">
            <i class="bi bi-box-arrow-in-left" aria-hidden="true"></i> Load
          </button>
        </div>
        <pre class="grammar-display small bg-light rounded p-2 mb-2">${escapeHtml(grammarToText(createGrammar(sample)))}</pre>
        <div class="small">
          <span class="text-success me-2">
            <i class="bi bi-check-circle" aria-hidden="true"></i>
            ${sample.testStrings.accept.map((s) => `<code>${escapeHtml(s || 'ε')}</code>`).join(' ')}
          </span>
          <span class="text-danger">
            <i class="bi bi-x-circle" aria-hidden="true"></i>
            ${sample.testStrings.reject.map((s) => `<code>${escapeHtml(s || 'ε')}</code>`).join(' ')}
          </span>
        </div>
      </div>`
    )
    .join('');

  els.sampleList.querySelectorAll('[data-sample-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const sample = samples.find((s) => s.id === button.dataset.sampleId);
      if (sample) loadIntoEditor(sample, { sourceLabel: `the sample "${sample.name}"` });
    });
  });

  initTooltips(els.sampleList);
}

/* ------------------------------------------------------------------------ */
/* Import from JSON file                                                     */
/* ------------------------------------------------------------------------ */

async function onImportFile() {
  const file = els.fileInput.files?.[0];
  els.fileInput.value = ''; // allow re-selecting the same file later
  if (!file) return;

  try {
    const text = await readFileText(file);
    const result = deserializeGrammar(text);
    if (!result.ok) {
      showToast(`Import failed: ${result.error}`, 'danger', 6000);
      return;
    }
    loadIntoEditor(result.grammar, { sourceLabel: `"${file.name}"` });
    showToast('Review the imported grammar, then press Save to keep it.', 'info', 6000);
  } catch (err) {
    showToast(err.message, 'danger');
  }
}
