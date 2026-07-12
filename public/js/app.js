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
 */
export const events = new EventTarget();

export function emit(name, detail = undefined) {
  events.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Replace the working grammar (load/import/new). Resets stale results. */
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

/** Signal that the working grammar was persisted server-side. */
export function markGrammarSaved(id) {
  state.grammarId = id;
  state.dirty = false;
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

  // View modules register themselves here as they are implemented.
  // Each exports an init() that renders into its #<name>-root container.
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', init)
  : init();
