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
 */
async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
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
    throw error;
  }

  return body;
}

export const api = {
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

/** Read a user-selected File and resolve with its text content. */
export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}
