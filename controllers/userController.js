/**
 * controllers/userController.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   HTTP handling for account management. Every handler passes req.user — the
 *   actor — into the service as the first argument and makes no decision of
 *   its own about what that actor is allowed to do. All of that lives in
 *   canAccess() in services/userService.js.
 *
 *   That the actor comes from req.user and never from the request body is the
 *   point: a client cannot claim to be someone else, because the only thing
 *   it sends is a session cookie the server resolves itself.
 */

import { asyncHandler } from '../utils/asyncHandler.js';
import * as userService from '../services/userService.js';

/**
 * GET /api/users
 * Response: 200 with the users inside the caller's jurisdiction — every
 *           account for an admin, their own students for a teacher.
 */
export const listUsers = asyncHandler(async (req, res) => {
  res.json(await userService.listUsers(req.user));
});

/**
 * POST /api/users
 * Body:     { username, password, role, teacherId? }
 *           teacherId is required when an admin creates a student and ignored
 *           when a teacher does — their students are always their own.
 * Response: 201 with the created user / 400 / 403 / 409 USERNAME_TAKEN.
 */
export const createUser = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.user, req.body ?? {});
  res.status(201).json(user);
});

/**
 * DELETE /api/users/:id
 * Their students, grammars and sessions go with them (ON DELETE CASCADE).
 * Response: 204 / 403 / 404 USER_NOT_FOUND.
 */
export const deleteUser = asyncHandler(async (req, res) => {
  await userService.deleteUser(req.user, req.params.id);
  res.status(204).end();
});

/**
 * POST /api/users/:id/password
 * Body:     { newPassword }
 * Recovery for a forgotten password; closes every session the target holds.
 * Response: 204 / 400 WEAK_PASSWORD / 403 / 404.
 */
export const resetPassword = asyncHandler(async (req, res) => {
  await userService.resetPassword(req.user, req.params.id, (req.body ?? {}).newPassword);
  res.status(204).end();
});

/**
 * GET /api/users/password-suggestion
 * A password generated server-side, offered in the create and reset dialogs
 * so an account is not created with something guessable by default.
 * Response: 200 { password }.
 */
export const suggestPassword = asyncHandler(async (req, res) => {
  res.json({ password: userService.suggestPassword() });
});
