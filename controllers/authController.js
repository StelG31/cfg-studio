/**
 * controllers/authController.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   HTTP handling for signing in and out. Thin by design, with one job that
 *   is genuinely its own: the session cookie. A cookie is a transport detail,
 *   so authService returns a raw token and this layer decides it travels as
 *   Set-Cookie — the service never touches req or res.
 *
 *   The raw token is never put in a response body. Sending it as JSON would
 *   hand it to any script on the page and undo httpOnly entirely.
 */

import { asyncHandler } from '../utils/asyncHandler.js';
import * as authService from '../services/authService.js';
import {
  readSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from '../utils/sessionCookie.js';

/**
 * POST /api/auth/login
 * Body:     { username, password }
 * Response: 200 with the signed-in user + an httpOnly session cookie;
 *           401 INVALID_CREDENTIALS otherwise (identical for an unknown
 *           username and a wrong password).
 */
export const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body ?? {};
  const { user, token } = await authService.login(username, password);

  setSessionCookie(res, token);
  res.json(user);
});

/**
 * POST /api/auth/logout
 * Deletes the session row, then the cookie. Order matters: the row is the
 * thing that grants access, so it goes first.
 * Response: 204.
 */
export const logout = asyncHandler(async (req, res) => {
  await authService.logout(readSessionToken(req));
  clearSessionCookie(res);
  res.status(204).end();
});

/**
 * GET /api/auth/me
 * Response: 200 with the signed-in user; 401 UNAUTHENTICATED when there is no
 *           valid session — which is how the browser learns to show the login
 *           screen on first load.
 */
export const me = asyncHandler(async (req, res) => {
  res.json(req.user);
});

/**
 * POST /api/auth/password
 * Body:     { currentPassword, newPassword }
 * Changes the caller's OWN password. Every other session is closed and this
 * one is replaced, so the browser making the change stays signed in.
 * Response: 204 / 400 WEAK_PASSWORD / 401 INVALID_CREDENTIALS.
 */
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  const { token } = await authService.changeOwnPassword(req.user, currentPassword, newPassword);

  setSessionCookie(res, token);
  res.status(204).end();
});
