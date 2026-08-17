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
  /**
   * The signed-in user ({id, username, role, teacherId}), or null.
   *
   * Views read this to decide what to OFFER — a student is shown no user
   * management, a teacher no Delete button on a student's grammar. None of
   * that is a security measure: the server re-decides every request through
   * canAccess() and would refuse anyway. Hiding a control the server would
   * reject is a courtesy to the user, not a lock.
   */
  user: null,
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
 *  - 'user-changed'     someone signed in or out; state.user is current
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
 * Record who is signed in (or that nobody is), and bring the shell into
 * line: the navigation and the current-grammar indicator only make sense
 * once there is a user, and the login screen only makes sense while there is
 * not.
 *
 * Signing out also drops the working grammar and every derived result. The
 * next person at this browser must not find the previous one's work sitting
 * in the editor.
 *
 * @param {object|null} user The signed-in user, or null.
 */
export function setUser(user) {
  const signedOut = user === null;
  state.user = user;

  if (signedOut) {
    state.grammar = null;
    state.grammarId = null;
    state.dirty = false;
    state.cnf = null;
    state.cyk = null;
  }

  document.body.classList.toggle('signed-in', !signedOut);
  updateUserIndicator();
  updateGrammarIndicator();
  emit('user-changed', { user });

  // Repaint unconditionally: signing in or out changes which sections are
  // reachable, and the visible one has to be re-resolved either way. Doing it
  // only when the hash says 'login' would leave the login card on screen
  // after a successful sign-in from the bare URL, where the hash is empty.
  // showSection() itself maps 'login' to the default section once there is a
  // user, and everything to 'login' once there is not.
  showSection(sectionFromHash());
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
/* Navbar indicators: current grammar, and who is signed in                  */
/* ------------------------------------------------------------------------ */

function updateGrammarIndicator() {
  const nameEl = document.getElementById('currentGrammarName');
  const dotEl = document.getElementById('unsavedDot');
  if (!nameEl || !dotEl) return;
  nameEl.textContent = state.grammar?.name?.trim() || 'Untitled grammar';
  dotEl.classList.toggle('d-none', !state.dirty);
}

/**
 * Show the signed-in user's name and role, and reveal the "Users" entry only
 * to the roles that have one. A student is not shown a screen the server
 * would answer with 403.
 */
function updateUserIndicator() {
  const nameEl = document.getElementById('currentUserName');
  const roleEl = document.getElementById('currentUserRole');
  if (nameEl) nameEl.textContent = state.user?.username ?? '';
  if (roleEl) roleEl.textContent = state.user?.role ?? '';

  const manages = state.user?.role === 'admin' || state.user?.role === 'teacher';
  document.getElementById('navUsersItem')?.classList.toggle('d-none', !manages);
}

/* ------------------------------------------------------------------------ */
/* Hash-based section navigation                                             */
/* ------------------------------------------------------------------------ */

const SECTION_NAMES = ['editor', 'cnf', 'cyk', 'tree', 'grammars', 'users', 'help', 'login'];
const DEFAULT_SECTION = 'editor';

function sectionFromHash() {
  const name = window.location.hash.replace(/^#/, '');
  return SECTION_NAMES.includes(name) ? name : DEFAULT_SECTION;
}

/** Sections that only some roles have any use for. */
const SECTION_ROLES = { users: ['admin', 'teacher'] };

/**
 * Where a request for section `name` actually lands, given who is signed in.
 *
 * Three redirections, in order: nobody signed in can only be at the login
 * screen; somebody signed in has no use for it; and a section this role does
 * not have goes to the default one. That last case is what stops a student
 * who types #users — or who was left on it when a teacher signed out of this
 * browser — from being shown a screen built for somebody else.
 *
 * This is the front door, not a lock. The data behind every section comes
 * from an API that decides for itself, and answers a student asking about
 * users with 403 no matter what the page is currently showing.
 */
function resolveSection(name) {
  if (state.user === null) return 'login';
  if (name === 'login') return DEFAULT_SECTION;

  const allowed = SECTION_ROLES[name];
  return allowed && !allowed.includes(state.user.role) ? DEFAULT_SECTION : name;
}

/** Show one section, hide the rest, and sync the navbar's active state. */
function showSection(name) {
  const target = resolveSection(name);

  for (const sectionName of SECTION_NAMES) {
    const section = document.getElementById(`section-${sectionName}`);
    if (section) section.classList.toggle('active', sectionName === target);
  }
  for (const link of document.querySelectorAll('[data-section-link]')) {
    link.classList.toggle('active', link.dataset.sectionLink === target);
  }
  // Collapse the mobile menu after choosing a destination.
  const collapseEl = document.getElementById('mainNav');
  if (collapseEl?.classList.contains('show')) {
    window.bootstrap.Collapse.getOrCreateInstance(collapseEl).hide();
  }
  window.scrollTo({ top: 0 }); // a section switch is a page change
  emit('section-shown', { name: target });
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

/**
 * Ask the server who we are. A 401 is the ordinary answer for a first visit,
 * not an error worth reporting — it simply means "show the login screen".
 *
 * @returns {Promise<object|null>}
 */
async function resolveCurrentUser() {
  const { api } = await import('./storage.js');
  try {
    return await api.me();
  } catch (err) {
    if (err.status === 401) return null;
    throw err; // a real failure (server down, network) must not look like a logout
  }
}

async function init() {
  window.addEventListener('hashchange', () => showSection(sectionFromHash()));

  // Activate every statically declared tooltip once the DOM is ready.
  const { initTooltips, showToast } = await import('./ui.js');
  initTooltips(document);

  // Any API call may discover that the session has gone (expired, revoked,
  // or the account deleted). storage.js announces it; the response is the
  // same wherever it happened, so it is written once, here.
  window.addEventListener('session-lost', () => {
    if (state.user === null) return; // already on the login screen
    setUser(null);
    showToast('Your session has ended. Please sign in again.', 'warning', 6000);
  });

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
  //
  // The views are wired up BEFORE the identity is known, so that whichever
  // way setUser() goes below there is already someone subscribed to
  // 'user-changed' to react to it.
  const loginView = await import('./views/login-view.js');
  loginView.init();
  const editorView = await import('./views/editor-view.js');
  editorView.init();
  const grammarsView = await import('./views/grammars-view.js');
  grammarsView.init();
  const usersView = await import('./views/users-view.js');
  usersView.init();
  const cnfView = await import('./views/cnf-view.js');
  cnfView.init();
  const cykView = await import('./views/cyk-view.js');
  cykView.init();
  const treeView = await import('./views/tree-view.js');
  treeView.init();

  // setUser() paints the first section itself, so there is no separate
  // showSection() call here — a second one would emit 'section-shown' twice
  // and make every view refresh itself for nothing.
  try {
    setUser(await resolveCurrentUser());
  } catch (err) {
    setUser(null);
    showToast(`Could not reach the server: ${err.message}`, 'danger', 8000);
  }
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', init)
  : init();
