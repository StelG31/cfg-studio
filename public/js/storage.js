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
