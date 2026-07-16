/**
 * public/js/app.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Frontend entry point and the only owner of application-wide state.
 *
 *   CFG Studio is a single-page application without a framework, so this
 *   module provides the two mechanisms a framework would normally supply:
 *
 *     1. STATE — one shared `state` object holding the working grammar and
 *        the latest computation results (CNF conversion, CYK run). Views
 *        read it directly and mutate it ONLY through the setters below.
 *
 *     2. EVENTS — a DOM EventTarget used as a publish/subscribe bus.
 *        When state changes, the responsible setter emits an event and
 *        every interested view re-renders itself. This keeps the view
 *        modules fully decoupled from one another.
 *
 *   It also implements hash-based section switching (#editor, #cnf, ...):
 *   exactly one <section class="app-section"> is visible at a time, which
 *   gives the app shareable URLs and working back/forward navigation
 *   for free.
 */

/* ------------------------------------------------------------------------ */
/* Shared application state                                                  */
/* ------------------------------------------------------------------------ */

export const state = {
  /** The grammar currently being edited (a plain grammar object). */
  grammar: null,
  /** Server-side id when the grammar has been saved; null for drafts. */
  grammarId: null,
  /** True when the editor has changes not yet persisted. */
  dirty: false,
  /** Result of the last CNF conversion ({original, steps, result, ...}). */
  cnf: null,
  /** Result of the last CYK run ({grammar, input, result}). */
  cyk: null,
};

/** Application-wide event bus. Event names used across views:
 *  - 'grammar-changed'  the working grammar was edited in place
 *  - 'grammar-loaded'   a different grammar replaced the working one
 *  - 'cnf-computed'     state.cnf holds a fresh conversion
 *  - 'cyk-computed'     state.cyk holds a fresh simulation
 *  - 'section-shown'    a section became visible ({detail: {name}}) —
 *                       views use it to refresh lazily / refit layouts
 */
export const events = new EventTarget();

/**
 * Publish an application event on the shared bus.
 *
 * @param {string} name   One of the event names documented above.
 * @param {*} [detail]    Optional payload, delivered as event.detail.
 */
export function emit(name, detail = undefined) {
  events.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Replace the working grammar (load / import / new).
 *
 * Clearing state.cnf and state.cyk here (and in markGrammarEdited) is the
 * INVALIDATION INVARIANT the whole pipeline relies on: downstream views may
 * trust a non-null state.cnf/state.cyk precisely because any change to the
 * grammar destroys them.
 *
 * @param {object} grammar The new working grammar.
 * @param {{id?: string|null}} [options] Server document id, if loaded from storage.
 */
export function setGrammar(grammar, { id = null } = {}) {
  state.grammar = grammar;
  state.grammarId = id;
  state.dirty = false;
  state.cnf = null;
  state.cyk = null;
  emit('grammar-loaded');
  updateGrammarIndicator();
}

/** Signal that the working grammar was edited in the editor. */
export function markGrammarEdited() {
  state.dirty = true;
  // Editing invalidates every downstream computation.
  state.cnf = null;
  state.cyk = null;
  emit('grammar-changed');
  updateGrammarIndicator();
}

/**
 * Signal that the working grammar was persisted server-side.
 *
 * @param {string|null} id The stored document's id (null clears the link).
 */
export function markGrammarSaved(id) {
  state.grammarId = id;
  state.dirty = false;
  updateGrammarIndicator();
}

/**
 * Set the unsaved flag explicitly (used when restoring a clean draft:
 * the restore path re-runs the edit pipeline, which marks dirty, and then
 * corrects the flag to what the draft actually recorded).
 *
 * @param {boolean} value
 */
export function setDirty(value) {
  state.dirty = Boolean(value);
  updateGrammarIndicator();
}

/* ------------------------------------------------------------------------ */
/* Navbar indicator: current grammar name + unsaved dot                      */
/* ------------------------------------------------------------------------ */

function updateGrammarIndicator() {
  const nameEl = document.getElementById('currentGrammarName');
  const dotEl = document.getElementById('unsavedDot');
  if (!nameEl || !dotEl) return;
  nameEl.textContent = state.grammar?.name?.trim() || 'Untitled grammar';
  dotEl.classList.toggle('d-none', !state.dirty);
}

/* ------------------------------------------------------------------------ */
/* Hash-based section navigation                                             */
/* ------------------------------------------------------------------------ */

const SECTION_NAMES = ['editor', 'cnf', 'cyk', 'tree', 'grammars', 'help'];
const DEFAULT_SECTION = 'editor';

function sectionFromHash() {
  const name = window.location.hash.replace(/^#/, '');
  return SECTION_NAMES.includes(name) ? name : DEFAULT_SECTION;
}

/** Show one section, hide the rest, and sync the navbar's active state. */
function showSection(name) {
  for (const sectionName of SECTION_NAMES) {
    const section = document.getElementById(`section-${sectionName}`);
    if (section) section.classList.toggle('active', sectionName === name);
  }
  for (const link of document.querySelectorAll('[data-section-link]')) {
    link.classList.toggle('active', link.dataset.sectionLink === name);
  }
  // Collapse the mobile menu after choosing a destination.
  const collapseEl = document.getElementById('mainNav');
  if (collapseEl?.classList.contains('show')) {
    window.bootstrap.Collapse.getOrCreateInstance(collapseEl).hide();
  }
  window.scrollTo({ top: 0 }); // a section switch is a page change
  emit('section-shown', { name });
}

/** Programmatic navigation used by views ("Use in CYK →" etc.). */
export function navigateTo(name) {
  if (window.location.hash === `#${name}`) {
    showSection(name); // hash unchanged → no hashchange event → show manually
  } else {
    window.location.hash = `#${name}`;
  }
}

/* ------------------------------------------------------------------------ */
/* Bootstrapping                                                             */
/* ------------------------------------------------------------------------ */

async function init() {
  window.addEventListener('hashchange', () => showSection(sectionFromHash()));
  showSection(sectionFromHash());
  updateGrammarIndicator();

  // Activate every statically declared tooltip once the DOM is ready.
  const { initTooltips } = await import('./ui.js');
  initTooltips(document);

  // View modules register themselves here as they are implemented.
  // Each exports an init() that renders into its #<name>-root container.
  //
  // ORDER COUPLING, documented on purpose: the editor initialises FIRST and
  // may emit events during its init (draft restore) before the other views
  // have subscribed. That is safe only because every view also renders
  // itself unconditionally inside its own init() — a view added here must
  // follow the same rule rather than rely on catching the editor's events.
  // (Dynamic import also breaks the static import cycle: views import
  // app.js at module load; app.js loads views only at runtime.)
  const editorView = await import('./views/editor-view.js');
  editorView.init();
  const grammarsView = await import('./views/grammars-view.js');
  grammarsView.init();
  const cnfView = await import('./views/cnf-view.js');
  cnfView.init();
  const cykView = await import('./views/cyk-view.js');
  cykView.init();
  const treeView = await import('./views/tree-view.js');
  treeView.init();
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', init)
  : init();
