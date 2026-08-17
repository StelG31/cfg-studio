/**
 * public/js/views/users-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The user-management screen. What it shows depends on who is looking:
 *
 *     admin    every account; may create teachers and students, delete
 *              anyone but themselves, and reset any password.
 *     teacher  their own students only; may create more of them, delete
 *              them, and reset their passwords.
 *     student  never sees this screen at all.
 *
 *   Every restriction above is also enforced server-side by canAccess(), and
 *   that is the one that counts. What this module does is decline to OFFER
 *   buttons the server would refuse — a courtesy, so nobody is invited to
 *   click something that can only fail. The screen being hidden from a
 *   student is not what stops a student managing users; the 403 is.
 *
 * DOM contract (views/index.html):
 *   #usersList #usersSubtitle #btnRefreshUsers
 *   #createUserForm #newUserRole #newUserTeacherGroup #newUserTeacher
 *   #newUserName #newUserPassword #btnSuggestPassword #createUserError
 */

import { state, events } from '../app.js';
import { escapeHtml, showToast, confirmDialog, setLoading, initTooltips } from '../ui.js';
import { api } from '../storage.js';

const els = {};

/** The last list fetched, so an action can name the user it is about. */
let currentUsers = [];

const ROLE_BADGE = {
  admin: 'text-bg-danger',
  teacher: 'text-bg-primary',
  student: 'text-bg-secondary',
};

export function init() {
  els.list = document.getElementById('usersList');
  els.subtitle = document.getElementById('usersSubtitle');
  els.refresh = document.getElementById('btnRefreshUsers');
  els.form = document.getElementById('createUserForm');
  els.role = document.getElementById('newUserRole');
  els.teacherGroup = document.getElementById('newUserTeacherGroup');
  els.teacher = document.getElementById('newUserTeacher');
  els.username = document.getElementById('newUserName');
  els.password = document.getElementById('newUserPassword');
  els.suggest = document.getElementById('btnSuggestPassword');
  els.error = document.getElementById('createUserError');

  els.refresh.addEventListener('click', () => refresh());
  els.form.addEventListener('submit', onCreate);
  els.role.addEventListener('change', syncTeacherField);
  els.suggest.addEventListener('click', fillSuggestedPassword);

  // Refresh whenever the section becomes visible: cheap, and it keeps the
  // list correct after an account was created or deleted elsewhere.
  events.addEventListener('section-shown', (event) => {
    if (event.detail?.name === 'users') refresh();
  });

  // Signing in as somebody else changes what this screen even is. Wipe the
  // rendered list FIRST and unconditionally: it names real accounts, and the
  // next person at this browser may be a student with no business seeing
  // them. Waiting for a re-fetch would leave the previous user's list on
  // screen in exactly the case where it must not be — a student, for whom
  // refresh() does nothing at all.
  events.addEventListener('user-changed', () => {
    currentUsers = [];
    els.list.innerHTML = '';
    els.form.reset();
    if (!manages()) return;

    renderRoleOptions();
    refresh();
  });

  renderRoleOptions();
}

/** True when the current user manages accounts at all. */
function manages() {
  return state.user?.role === 'admin' || state.user?.role === 'teacher';
}

/* ------------------------------------------------------------------------ */
/* The create form                                                           */
/* ------------------------------------------------------------------------ */

/**
 * A teacher may only ever create students, so they are offered exactly that
 * and no dropdown to misread.
 */
function renderRoleOptions() {
  if (!manages()) return;

  const roles =
    state.user.role === 'admin'
      ? [
          ['student', 'Student'],
          ['teacher', 'Teacher'],
        ]
      : [['student', 'Student']];

  els.role.innerHTML = roles
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('');
  els.role.disabled = roles.length === 1;

  els.subtitle.textContent =
    state.user.role === 'admin'
      ? 'Every account on this server. Teachers and students are created here.'
      : 'Your students. Each one you create belongs to you.';

  syncTeacherField();
}

/**
 * The teacher picker is only meaningful for an admin creating a student —
 * a teacher's students are always their own, and an admin creating another
 * teacher has nobody to assign.
 */
function syncTeacherField() {
  const needed = state.user?.role === 'admin' && els.role.value === 'student';
  els.teacherGroup.classList.toggle('d-none', !needed);
  if (needed) fillTeacherOptions();
}

function fillTeacherOptions() {
  const teachers = currentUsers.filter((user) => user.role === 'teacher');

  if (teachers.length === 0) {
    els.teacher.innerHTML = '<option value="">— no teachers exist yet —</option>';
    return;
  }

  const previous = els.teacher.value;
  els.teacher.innerHTML = teachers
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.username)}</option>`)
    .join('');
  if (teachers.some((t) => t.id === previous)) els.teacher.value = previous;
}

async function fillSuggestedPassword() {
  try {
    const { password } = await api.suggestPassword();
    els.password.value = password;
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

function showFormError(message) {
  els.error.innerHTML = escapeHtml(message);
  els.error.classList.remove('d-none');
}

async function onCreate(event) {
  event.preventDefault();
  els.error.classList.add('d-none');

  const payload = {
    username: els.username.value.trim(),
    password: els.password.value,
    role: els.role.value,
  };

  if (payload.role === 'student' && state.user.role === 'admin') {
    if (els.teacher.value === '') {
      showFormError('Create a teacher first — every student must belong to one.');
      return;
    }
    payload.teacherId = els.teacher.value;
  }

  setLoading(true, 'Creating account…');
  try {
    const created = await api.createUser(payload);
    showToast(
      `Created ${created.role} "${created.username}". Give them the password now — it is not shown again.`,
      'success',
      8000
    );
    els.form.reset();
    renderRoleOptions();
    await refresh();
  } catch (err) {
    showFormError(err.message);
  } finally {
    setLoading(false);
  }
}

/* ------------------------------------------------------------------------ */
/* The account list                                                          */
/* ------------------------------------------------------------------------ */

async function refresh() {
  if (!manages()) return;

  try {
    currentUsers = await api.listUsers();
    render(currentUsers);
    fillTeacherOptions();
  } catch (err) {
    els.list.innerHTML = `<p class="text-danger mb-0">Could not load users: ${escapeHtml(err.message)}</p>`;
  }
}

/**
 * Paint the account list. Buttons carry data-action/data-id and share one
 * handler; the container is rebuilt wholesale on every refresh, so listeners
 * never accumulate.
 *
 * @param {object[]} users Rows from GET /api/users.
 */
function render(users) {
  if (users.length === 0) {
    els.list.innerHTML = `
      <div class="text-center text-secondary py-4">
        <i class="bi bi-people fs-2 d-block mb-2" aria-hidden="true"></i>
        ${
          state.user.role === 'admin'
            ? 'No accounts yet.'
            : 'No students yet — create one with the form beside this list.'
        }
      </div>`;
    return;
  }

  // Resolves teacher_id to a name for the "teacher: …" line. Only an admin's
  // list contains teachers at all; a teacher's list is their own students, so
  // the lookup misses and the line is simply omitted — which is right, since
  // that teacher is the reader.
  const teacherNames = new Map(users.map((user) => [user.id, user.username]));

  els.list.innerHTML = `
    <ul class="list-group list-group-flush">
      ${users
        .map((user) => {
          const isSelf = user.id === state.user.id;
          const belongsTo = user.teacherId ? teacherNames.get(user.teacherId) : null;

          return `
        <li class="list-group-item px-0 d-flex justify-content-between align-items-start gap-2 flex-wrap">
          <div class="me-auto">
            <div class="fw-semibold">
              ${escapeHtml(user.username)}
              <span class="badge ${ROLE_BADGE[user.role] ?? 'text-bg-secondary'} ms-1">${escapeHtml(user.role)}</span>
              ${isSelf ? '<span class="badge text-bg-light ms-1">you</span>' : ''}
            </div>
            <div class="small text-secondary">
              ${belongsTo ? `teacher: ${escapeHtml(belongsTo)} · ` : ''}created ${escapeHtml(new Date(user.createdAt).toLocaleDateString())}
            </div>
          </div>
          <div class="btn-group btn-group-sm" role="group" aria-label="Actions for ${escapeHtml(user.username)}">
            ${
              // Neither action is offered on your own row. Delete, because
              // canAccess refuses it outright. Reset, because it would work —
              // and would sign you out on the spot, since a reset drops every
              // session of the account it touches. "Change password" in the
              // account menu is the way to change your own, and it keeps you
              // signed in here.
              isSelf
                ? '<span class="text-secondary small fst-italic px-2">your account</span>'
                : `<button type="button" class="btn btn-outline-secondary" data-action="reset"
                    data-id="${escapeHtml(user.id)}" data-name="${escapeHtml(user.username)}"
                    data-bs-toggle="tooltip" title="Set a new password">
              <i class="bi bi-key" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-outline-danger" data-action="delete"
                    data-id="${escapeHtml(user.id)}" data-name="${escapeHtml(user.username)}"
                    data-role-name="${escapeHtml(user.role)}"
                    data-bs-toggle="tooltip" title="Delete this account">
              <i class="bi bi-trash" aria-hidden="true"></i>
            </button>`
            }
          </div>
        </li>`;
        })
        .join('')}
    </ul>`;

  els.list.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => onUserAction(button));
  });
  initTooltips(els.list);
}

/**
 * Dispatch a list-button click. Both actions are destructive in their own
 * way — one removes an account and everything hanging off it, the other
 * locks its owner out until they are told the new password — so both ask
 * first, and the deletion message spells out the cascade rather than saying
 * a bland "are you sure?".
 *
 * @param {HTMLButtonElement} button The clicked action button.
 */
async function onUserAction(button) {
  const { action, id, name, roleName } = button.dataset;

  if (action === 'delete') {
    const consequence =
      roleName === 'teacher'
        ? `Deleting "${name}" also deletes every student of theirs, and every grammar those students saved.`
        : `Deleting "${name}" also deletes every grammar they saved.`;

    const confirmed = await confirmDialog({
      title: 'Delete this account?',
      message: `${consequence} This cannot be undone.`,
      confirmText: 'Delete',
    });
    if (!confirmed) return;

    setLoading(true, 'Deleting account…');
    try {
      await api.deleteUser(id);
      showToast(`Deleted "${name}".`, 'success');
      await refresh();
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  }

  if (action === 'reset') {
    let password;
    try {
      ({ password } = await api.suggestPassword());
    } catch (err) {
      showToast(err.message, 'danger');
      return;
    }

    const confirmed = await confirmDialog({
      title: `Reset the password for "${name}"?`,
      message:
        `The new password will be ${password} — write it down now, because it is not shown again. ` +
        'They will be signed out everywhere and must use this password next time.',
      confirmText: 'Reset password',
      confirmClass: 'btn-warning',
    });
    if (!confirmed) return;

    setLoading(true, 'Resetting password…');
    try {
      await api.resetPassword(id, password);
      showToast(`New password for "${name}": ${password}`, 'success', 15000);
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  }
}
