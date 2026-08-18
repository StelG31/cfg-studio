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

  // Drop the rendered list the moment the signed-in user changes, and only
  // then re-fetch. The list names other people's work, so the previous
  // account's grammars must not still be on screen for the next one — not
  // even for the moment between this section becoming visible and its
  // re-fetch returning.
  events.addEventListener('user-changed', () => {
    els.savedList.innerHTML = '';
    if (state.user !== null) refreshSaved();
  });

  // Nothing to fetch until somebody is signed in; the request would only 401.
  // The samples are public, so they load either way.
  if (state.user !== null) refreshSaved();
  renderSamples();
}

/* ------------------------------------------------------------------------ */
/* Loading a grammar into the editor (shared by saved/sample/import paths)   */
/* ------------------------------------------------------------------------ */

/**
 * Make `grammar` the working grammar. Replaces the editor draft: loading is
 * an explicit user decision, so the previous draft has been superseded.
 *
 * Passing id: null for a grammar somebody else owns is what makes a teacher's
 * access to a student's work genuinely read-only. The editor treats a null id
 * as an unsaved draft, so Save creates the teacher's OWN copy instead of
 * attempting to overwrite the student's — which the server would refuse with
 * a 403 anyway. The student's work is opened, studied, never altered.
 *
 * borrowedFrom carries the owner's name past that deliberate loss of id, so
 * the editor can say whose original it left alone when the copy is saved.
 */
function loadIntoEditor(grammar, { id = null, borrowedFrom = null, sourceLabel }) {
  clearDraft();
  setGrammar(createGrammar(grammar), { id, borrowedFrom });
  navigateTo('editor');
  showToast(`Loaded ${sourceLabel}.`, 'success');
}

/** True when the signed-in user owns this document. */
function isOwn(doc) {
  return doc.ownerId === undefined || doc.ownerId === state.user?.id;
}

/* ------------------------------------------------------------------------ */
/* Saved grammars                                                            */
/* ------------------------------------------------------------------------ */

/** Re-fetch the saved list from the server and repaint it (or an error). */
async function refreshSaved() {
  try {
    const list = await api.listGrammars();
    renderSaved(list);
  } catch (err) {
    els.savedList.innerHTML = `<p class="text-danger mb-0">Could not load saved grammars: ${escapeHtml(err.message)}</p>`;
  }
}

/**
 * Paint the saved-grammar list. Action buttons carry data-action/data-id
 * attributes and share one handler (onSavedAction) — the list is rebuilt
 * wholesale on every refresh, so listeners never accumulate.
 *
 * @param {object[]} list Metadata entries from GET /api/grammars.
 */
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
        .map((doc) => {
          const own = isOwn(doc);
          return `
        <li class="list-group-item px-0 d-flex justify-content-between align-items-start gap-2 flex-wrap">
          <div class="me-auto">
            <div class="fw-semibold">
              ${escapeHtml(doc.name)}
              ${
                own
                  ? ''
                  : `<span class="badge text-bg-light ms-1" title="You can open and study this grammar, but only its owner can change it">
                       <i class="bi bi-eye" aria-hidden="true"></i> ${escapeHtml(doc.ownerUsername ?? 'another user')}
                     </span>`
              }
            </div>
            ${doc.description ? `<div class="small text-secondary">${escapeHtml(doc.description)}</div>` : ''}
            <div class="small text-secondary">
              |V| = ${doc.variableCount} · |Σ| = ${doc.terminalCount} · |P| = ${doc.productionCount}
              · updated ${escapeHtml(new Date(doc.updatedAt).toLocaleString())}
            </div>
          </div>
          <div class="btn-group btn-group-sm" role="group" aria-label="Actions for ${escapeHtml(doc.name)}">
            <button type="button" class="btn btn-outline-primary" data-action="load" data-id="${doc.id}">
              <i class="bi bi-box-arrow-in-left" aria-hidden="true"></i> ${own ? 'Load' : 'View'}
            </button>
            <button type="button" class="btn btn-outline-secondary" data-action="export" data-id="${doc.id}"
                    title="Download as JSON">
              <i class="bi bi-download" aria-hidden="true"></i>
            </button>
            ${
              // Someone else's grammar is not yours to delete; the server
              // agrees, so the button is simply not offered.
              own
                ? `<button type="button" class="btn btn-outline-danger" data-action="delete" data-id="${doc.id}"
                    data-name="${escapeHtml(doc.name)}" title="Delete">
              <i class="bi bi-trash" aria-hidden="true"></i>
            </button>`
                : ''
            }
          </div>
        </li>`;
        })
        .join('')}
    </ul>`;

  els.savedList.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => onSavedAction(button));
  });
}

/**
 * Dispatch a saved-list button click: load (into the editor, replacing the
 * draft), export (fetch full doc → serialize → download), or delete
 * (confirmation dialog first — every destructive action in the app asks).
 * Deleting the grammar currently open in the editor also clears
 * state.grammarId, since the server document no longer exists.
 *
 * @param {HTMLButtonElement} button The clicked action button.
 */
async function onSavedAction(button) {
  const { action, id, name } = button.dataset;

  if (action === 'load') {
    setLoading(true, 'Loading grammar…');
    try {
      const doc = await api.getGrammar(id);
      const own = isOwn(doc);
      const owner = doc.ownerUsername ?? 'another user';

      loadIntoEditor(doc, {
        id: own ? doc.id : null,
        borrowedFrom: own ? null : owner,
        sourceLabel: `"${doc.name}"`,
      });

      if (!own) {
        showToast(
          `This grammar belongs to ${owner}. Saving will create your own copy.`,
          'info',
          7000
        );
      }
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

/**
 * Paint the sample gallery: name, description, a rendered preview of the
 * productions, and the suggested accept/reject strings as chips — so a
 * student can see what to try in CYK before even loading the sample.
 */
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

/**
 * Import a grammar from a user-selected JSON file: read → deserialize with
 * the shared structural checker (its messages name the exact malformed
 * field) → load into the editor. The import does NOT auto-save: the user
 * reviews the grammar first and presses Save deliberately.
 */
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
