/**
 * utils/asyncHandler.js
 * -------------------------------------------------------------------------
 * Purpose:
 *   Express 4 does not catch rejected promises from async route handlers —
 *   an unhandled rejection would hang the request instead of reaching the
 *   error middleware. This wrapper forwards any rejection to next(), so
 *   every async controller can simply `throw` (e.g. an HttpError) and the
 *   central error handler takes over.
 *
 * Usage:
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 */

export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
