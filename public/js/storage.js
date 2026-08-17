/**
 * public/js/storage.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Everything that moves grammars in and out of the page:
 *     - draft autosave in localStorage (survives accidental tab closes),
 *     - (from the persistence step onwards) the REST API client and
 *       JSON export/import helpers.
 *
 *   Single responsibility: transport and persistence. No DOM rendering,
 *   no grammar logic.
 */

/* ------------------------------------------------------------------------ */
/* Draft autosave (localStorage)                                             */
/* ------------------------------------------------------------------------ */

const DRAFT_KEY = 'cfg-studio.editor-draft.v1';

/**
 * Persist a verbatim snapshot of the editor form. Storing the raw form
 * state (not the parsed grammar) means even half-typed, not-yet-valid
 * input survives a reload — exactly what a draft is for.
 */
export function saveDraft(snapshot) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot));
  } catch {
    /* Storage full or blocked (private mode) — a lost draft is not fatal. */
  }
}

/** @returns {object|null} the last saved draft, or null if none/corrupt. */
export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------------ */
/* REST API client                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Small fetch wrapper: JSON in/out, and every non-2xx response becomes a
 * thrown Error carrying the server's message and machine-readable code —
 * so views can simply try/catch and toast err.message.
 *
 * The thrown Error mirrors the server's HttpError shape (err.code,
 * err.details, err.status), making the client and server error models
 * symmetric — one mental model on both sides of the wire.
 *
 * The session cookie is httpOnly, so this module never sees it — it only has
 * to make sure the browser attaches it. `same-origin` is already the default
 * in current browsers; it is written out because a silently-dropped cookie
 * fails as "you are not signed in", which sends the reader looking in exactly
 * the wrong place.
 *
 * @param {string} path    API path, e.g. '/api/grammars'.
 * @param {object} [options] fetch() options (method, body, ...).
 * @returns {Promise<*>} parsed JSON body, or null for 204 responses.
 * @throws {Error} with {code, details, status} on any non-2xx response.
 */
async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (response.status === 204) return null;

  let body = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON response body (unexpected) — handled below */
  }

  if (!response.ok) {
    const message = body?.error?.message || `Request failed (${response.status})`;
    const error = new Error(message);
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    error.status = response.status;

    // A session that has expired or been revoked can surface on ANY call, so
    // it is handled once here rather than in every view's catch block. The
    // listener lives in app.js; storage.js stays a transport module and knows
    // nothing about screens.
    if (response.status === 401 && path !== '/api/auth/login') {
      window.dispatchEvent(new CustomEvent('session-lost'));
    }

    throw error;
  }

  return body;
}

export const api = {
  /* --- Authentication --------------------------------------------------- */

  /** POST /api/auth/login → the signed-in user (and an httpOnly cookie) */
  login: (username, password) =>
    apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  /** POST /api/auth/logout */
  logout: () => apiFetch('/api/auth/logout', { method: 'POST' }),
  /** GET /api/auth/me → the signed-in user; throws 401 when there is none */
  me: () => apiFetch('/api/auth/me'),
  /** POST /api/auth/password → change your own password */
  changePassword: (currentPassword, newPassword) =>
    apiFetch('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  /* --- User management --------------------------------------------------- */

  /** GET /api/users → the users within the caller's jurisdiction */
  listUsers: () => apiFetch('/api/users'),
  /** POST /api/users → the created user */
  createUser: (user) =>
    apiFetch('/api/users', { method: 'POST', body: JSON.stringify(user) }),
  /** DELETE /api/users/:id */
  deleteUser: (id) => apiFetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** POST /api/users/:id/password → reset someone else's password */
  resetPassword: (id, newPassword) =>
    apiFetch(`/api/users/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    }),
  /** GET /api/users/password-suggestion → { password } generated server-side */
  suggestPassword: () => apiFetch('/api/users/password-suggestion'),

  /* --- Grammars ---------------------------------------------------------- */

  /** GET /api/grammars → metadata list */
  listGrammars: () => apiFetch('/api/grammars'),
  /** GET /api/grammars/:id → full document */
  getGrammar: (id) => apiFetch(`/api/grammars/${encodeURIComponent(id)}`),
  /** POST /api/grammars → created document */
  createGrammar: (grammar) =>
    apiFetch('/api/grammars', { method: 'POST', body: JSON.stringify({ grammar }) }),
  /** PUT /api/grammars/:id → updated document */
  updateGrammar: (id, grammar) =>
    apiFetch(`/api/grammars/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ grammar }),
    }),
  /** DELETE /api/grammars/:id */
  deleteGrammar: (id) =>
    apiFetch(`/api/grammars/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** GET /api/examples → built-in sample grammars */
  listExamples: () => apiFetch('/api/examples'),
};

/* ------------------------------------------------------------------------ */
/* JSON export / import (client side)                                        */
/* ------------------------------------------------------------------------ */

/**
 * Offer a grammar as a .json download. Uses the same envelope format the
 * import understands (and the same shape the server stores).
 *
 * Two arguments on purpose: serialization lives in core/grammar.js, and
 * this transport module must not import grammar logic — so the CALLER
 * serializes (serializeGrammar) and this function only needs the grammar
 * object itself for the download filename.
 *
 * @param {object} grammar        The grammar (used for the file name only).
 * @param {string} serializedText The exact JSON text to download.
 */
export function downloadGrammarFile(grammar, serializedText) {
  const blob = new Blob([serializedText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  const safeName = (grammar.name || 'grammar')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  anchor.href = url;
  anchor.download = `${safeName || 'grammar'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Read a user-selected File and resolve with its text content.
 *
 * @param {File} file From an <input type="file"> change event.
 * @returns {Promise<string>} the file's text (rejects on read errors).
 */
export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}
