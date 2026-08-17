/**
 * public/js/views/login-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The sign-in screen, plus the account menu in the navigation bar (log out
 *   and change your own password). Both belong here because both are about
 *   the identity of whoever is at the keyboard, and nothing else is.
 *
 *   The failure message is deliberately the server's, verbatim: it says only
 *   "Incorrect username or password", never which of the two was wrong, and
 *   restating it here would be a chance to leak the difference.
 *
 * DOM contract (views/index.html):
 *   #loginForm #loginUsername #loginPassword #loginError #btnLogin
 *   #btnLogout #btnChangePassword
 */

import { state, setUser, events } from '../app.js';
import { escapeHtml, showToast, setLoading, confirmDialog } from '../ui.js';
import { api, clearDraft } from '../storage.js';

const els = {};

export function init() {
  els.form = document.getElementById('loginForm');
  els.username = document.getElementById('loginUsername');
  els.password = document.getElementById('loginPassword');
  els.error = document.getElementById('loginError');
  els.submit = document.getElementById('btnLogin');
  els.logout = document.getElementById('btnLogout');
  els.changePassword = document.getElementById('btnChangePassword');

  els.form.addEventListener('submit', onSubmit);
  els.logout.addEventListener('click', onLogout);
  els.changePassword.addEventListener('click', onChangePassword);

  // Put the cursor in the username box whenever the screen appears, so
  // signing in after a session ends takes no extra click.
  events.addEventListener('section-shown', (event) => {
    if (event.detail?.name === 'login') reset();
  });
}

/** Clear whatever the last attempt left behind. */
function reset() {
  els.form.reset();
  hideError();
  els.username.focus();
}

function showError(message) {
  els.error.innerHTML = escapeHtml(message);
  els.error.classList.remove('d-none');
}

function hideError() {
  els.error.classList.add('d-none');
}

/* ------------------------------------------------------------------------ */
/* Signing in                                                                */
/* ------------------------------------------------------------------------ */

async function onSubmit(event) {
  event.preventDefault(); // a full form POST would reload the page

  const username = els.username.value.trim();
  const password = els.password.value;

  if (username === '' || password === '') {
    showError('Enter your username and password.');
    return;
  }

  hideError();
  els.submit.disabled = true;
  setLoading(true, 'Signing in…');
  try {
    const user = await api.login(username, password);
    // A different person may be signing in at this browser; the previous
    // one's editor draft is not theirs to inherit.
    clearDraft();
    setUser(user);
    showToast(`Signed in as ${user.username}.`, 'success');
  } catch (err) {
    showError(err.message);
    els.password.value = '';
    els.password.focus();
  } finally {
    setLoading(false);
    els.submit.disabled = false;
  }
}

/* ------------------------------------------------------------------------ */
/* Signing out                                                               */
/* ------------------------------------------------------------------------ */

async function onLogout() {
  if (state.dirty) {
    const confirmed = await confirmDialog({
      title: 'Log out with unsaved changes?',
      message:
        'The grammar in the editor has changes that are not saved on the server. Logging out discards them.',
      confirmText: 'Log out',
    });
    if (!confirmed) return;
  }

  setLoading(true, 'Signing out…');
  try {
    await api.logout();
  } catch (err) {
    // The session is being abandoned either way; a failure here is worth
    // mentioning but must not trap someone on a screen they want to leave.
    showToast(`Sign-out reported a problem: ${err.message}`, 'warning');
  } finally {
    setLoading(false);
  }

  clearDraft();
  setUser(null);
  showToast('You are signed out.', 'info');
}

/* ------------------------------------------------------------------------ */
/* Changing your own password                                                */
/* ------------------------------------------------------------------------ */

/**
 * Ask for the current and new password in a modal.
 *
 * ui.js offers confirmDialog() but nothing that collects input, and a
 * password prompt is the only place in the app that needs one — so the modal
 * is built here rather than adding a half-general helper to ui.js for a
 * single caller.
 *
 * @returns {Promise<{currentPassword: string, newPassword: string}|null>}
 */
function passwordDialog() {
  return new Promise((resolve) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="modal fade" tabindex="-1" aria-labelledby="passwordTitle" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <form data-role="form">
              <div class="modal-header">
                <h2 class="modal-title h5" id="passwordTitle">Change your password</h2>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cancel"></button>
              </div>
              <div class="modal-body">
                <div class="mb-3">
                  <label for="pwCurrent" class="form-label">Current password</label>
                  <input type="password" class="form-control" id="pwCurrent"
                         autocomplete="current-password" required>
                </div>
                <div class="mb-1">
                  <label for="pwNew" class="form-label">New password</label>
                  <input type="password" class="form-control" id="pwNew"
                         autocomplete="new-password" minlength="8" required>
                  <div class="form-text">At least 8 characters.</div>
                </div>
                <p class="text-secondary small mb-0 mt-3">
                  You will stay signed in here. Any other browser you are signed in
                  on will be signed out.
                </p>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
                <button type="submit" class="btn btn-primary">Change password</button>
              </div>
            </form>
          </div>
        </div>
      </div>`;

    const modalEl = wrapper.firstElementChild;
    document.getElementById('modalContainer').appendChild(modalEl);

    let result = null;
    modalEl.querySelector('[data-role="form"]').addEventListener('submit', (event) => {
      event.preventDefault();
      result = {
        currentPassword: modalEl.querySelector('#pwCurrent').value,
        newPassword: modalEl.querySelector('#pwNew').value,
      };
      modal.hide();
    });
    modalEl.addEventListener('hidden.bs.modal', () => {
      modalEl.remove();
      resolve(result);
    });

    const modal = new window.bootstrap.Modal(modalEl);
    modal.show();
  });
}

async function onChangePassword() {
  const answer = await passwordDialog();
  if (answer === null) return;

  setLoading(true, 'Changing password…');
  try {
    await api.changePassword(answer.currentPassword, answer.newPassword);
    showToast('Your password has been changed.', 'success');
  } catch (err) {
    showToast(err.message, 'danger', 6000);
  } finally {
    setLoading(false);
  }
}
