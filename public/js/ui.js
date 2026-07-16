/**
 * public/js/ui.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Reusable user-interface primitives shared by every view module:
 *     - toast notifications           showToast()
 *     - confirmation dialogs          confirmDialog()   (Promise-based)
 *     - a global loading indicator    setLoading()
 *     - Bootstrap tooltip activation  initTooltips()
 *     - HTML escaping                 escapeHtml()
 *
 *   Single responsibility: this module knows how to TALK to the user,
 *   never WHAT to say — messages always come from the calling view.
 *
 *   Bootstrap's JS bundle is loaded as a classic script (window.bootstrap);
 *   it is accessed lazily inside functions so module evaluation order can
 *   never break.
 */

/** Escape a string for safe interpolation into innerHTML. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* Icon + colour per toast flavour. */
const TOAST_KINDS = {
  info:    { icon: 'bi-info-circle-fill',        cls: 'text-bg-dark' },
  success: { icon: 'bi-check-circle-fill',       cls: 'text-bg-success' },
  warning: { icon: 'bi-exclamation-circle-fill', cls: 'text-bg-warning' },
  danger:  { icon: 'bi-exclamation-triangle-fill', cls: 'text-bg-danger' },
};

/**
 * Show a transient notification in the bottom-right corner.
 * @param {string} message  Plain-text message (escaped automatically).
 * @param {'info'|'success'|'warning'|'danger'} [type]
 * @param {number} [delay]  Milliseconds before auto-hide.
 */
export function showToast(message, type = 'info', delay = 4000) {
  const kind = TOAST_KINDS[type] ?? TOAST_KINDS.info;
  const container = document.getElementById('toastContainer');

  const el = document.createElement('div');
  el.className = `toast align-items-center border-0 ${kind.cls}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">
        <i class="bi ${kind.icon} me-2" aria-hidden="true"></i>${escapeHtml(message)}
      </div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto"
              data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(el);

  const toast = new window.bootstrap.Toast(el, { delay });
  // Remove the DOM node once hidden so the container never accumulates junk.
  el.addEventListener('hidden.bs.toast', () => el.remove());
  toast.show();
}

/**
 * Ask the user to confirm an action (used before every destructive step).
 * Builds a one-off Bootstrap modal and resolves with the user's choice.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message      Plain text; escaped automatically.
 * @param {string} [options.confirmText]
 * @param {string} [options.confirmClass] Bootstrap button class for the action.
 * @returns {Promise<boolean>} true if confirmed, false otherwise.
 */
export function confirmDialog({
  title,
  message,
  confirmText = 'Confirm',
  confirmClass = 'btn-danger',
}) {
  return new Promise((resolve) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="modal fade" tabindex="-1" aria-labelledby="confirmTitle" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h2 class="modal-title h5" id="confirmTitle">${escapeHtml(title)}</h2>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cancel"></button>
            </div>
            <div class="modal-body"><p class="mb-0">${escapeHtml(message)}</p></div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn ${escapeHtml(confirmClass)}" data-role="confirm">
                ${escapeHtml(confirmText)}
              </button>
            </div>
          </div>
        </div>
      </div>`;
    const modalEl = wrapper.firstElementChild;
    document.getElementById('modalContainer').appendChild(modalEl);

    let confirmed = false;
    modalEl.querySelector('[data-role="confirm"]').addEventListener('click', () => {
      confirmed = true;
      modal.hide();
    });
    modalEl.addEventListener('hidden.bs.modal', () => {
      modalEl.remove();
      resolve(confirmed);
    });

    const modal = new window.bootstrap.Modal(modalEl);
    modal.show();
  });
}

/* ------------------------------------------------------------------------ */
/* Global loading indicator.                                                 */
/* A counter supports overlapping async operations: the overlay disappears   */
/* only when every caller that turned it on has turned it off again.         */
/* ------------------------------------------------------------------------ */

let loadingCount = 0;

/**
 * Show/hide the full-screen loading overlay. Callers must pair every
 * setLoading(true) with a setLoading(false) (typically in a finally block)
 * — the counter, not a boolean, is what makes overlapping API calls safe.
 *
 * @param {boolean} on     true to increment the counter, false to decrement.
 * @param {string} [label] Text under the spinner (last caller wins).
 */
export function setLoading(on, label = 'Working…') {
  loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));

  let overlay = document.getElementById('loadingOverlay');
  if (loadingCount > 0) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'loadingOverlay';
      overlay.className =
        'position-fixed top-0 start-0 w-100 h-100 d-flex flex-column align-items-center ' +
        'justify-content-center gap-3';
      overlay.style.cssText = 'background: rgba(255,255,255,.65); z-index: 2000; backdrop-filter: blur(1px);';
      overlay.innerHTML = `
        <div class="spinner-border text-primary" role="status" aria-hidden="true"></div>
        <div class="fw-semibold text-secondary" data-role="label"></div>`;
      document.body.appendChild(overlay);
    }
    overlay.querySelector('[data-role="label"]').textContent = label;
  } else if (overlay) {
    overlay.remove();
  }
}

/**
 * Activate Bootstrap tooltips for all [data-bs-toggle="tooltip"] elements
 * under the given root. Views call this after (re)rendering their DOM.
 */
export function initTooltips(root = document) {
  for (const el of root.querySelectorAll('[data-bs-toggle="tooltip"]')) {
    window.bootstrap.Tooltip.getOrCreateInstance(el);
  }
}
