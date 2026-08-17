/**
 * middleware/requireRole.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   A coarse gate that keeps whole route groups away from roles that have no
 *   business there at all — a student never has any reason to reach
 *   /api/users, so the request is stopped at the door rather than in a
 *   service.
 *
 *   This is NOT where authorization lives. It cannot be: role alone never
 *   answers "is this particular user within my jurisdiction?", which is what
 *   canAccess() in services/userService.js decides for every individual
 *   target. Deleting this middleware must not change what any request is
 *   permitted to do — only how early it is refused. Anything it protects is
 *   checked again, per target, underneath.
 *
 *   Kept that way on purpose: two independent gates, the outer one cheap and
 *   coarse, the inner one exact. Defence in depth, principle 6.
 */

import { HttpError } from '../utils/httpError.js';

/**
 * @param {...string} roles The roles allowed past this point.
 * @returns {import('express').RequestHandler}
 */
export function requireRole(...roles) {
  return function roleGate(req, res, next) {
    // Reached without requireAuth in front of it, req.user is undefined —
    // which denies, as it should.
    if (!req.user || !roles.includes(req.user.role)) {
      next(HttpError.forbidden('FORBIDDEN', 'Your role is not allowed to do that.'));
      return;
    }
    next();
  };
}
