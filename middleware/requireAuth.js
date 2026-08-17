/**
 * middleware/requireAuth.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Turn the session cookie into req.user, or refuse the request with 401.
 *
 *   Everything downstream may assume req.user is a real, current user: the
 *   session was looked up in the database on THIS request, so an account
 *   deleted a second ago is already gone. That is the property a self-
 *   contained token could not offer.
 *
 *   401 and not 403. The distinction is the client's instruction: 401 means
 *   "we do not know who you are", and public/js/storage.js reacts by showing
 *   the login screen. 403 means "we know exactly who you are and the answer
 *   is still no", which the user must be told rather than shown a login form
 *   they are already past.
 *
 *   asyncHandler is not optional here. Express 4 does not catch a rejected
 *   promise from middleware any more than from a handler, and an unhandled
 *   rejection would hang the request instead of failing it.
 */

import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/httpError.js';
import { readSessionToken } from '../utils/sessionCookie.js';
import * as authService from '../services/authService.js';

export const requireAuth = asyncHandler(async (req, res, next) => {
  const actor = await authService.resolveSession(readSessionToken(req));

  if (actor === null) {
    throw HttpError.unauthorized('UNAUTHENTICATED', 'You must sign in to do that.');
  }

  req.user = actor;
  next();
});
