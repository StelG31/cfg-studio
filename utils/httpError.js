/**
 * utils/httpError.js
 * -------------------------------------------------------------------------
 * Purpose:
 *   A small Error subclass that carries an HTTP status code and a stable,
 *   machine-readable error code. Services and controllers throw HttpError
 *   instances; the central error middleware (app.js) converts them into a
 *   consistent JSON body: { error: { code, message, details? } }.
 *
 *   Keeping error *creation* (here) separate from error *presentation*
 *   (middleware) means no route handler ever builds an error response by
 *   hand — one format, everywhere.
 */

export class HttpError extends Error {
  /**
   * @param {number} status  HTTP status code (400, 404, ...)
   * @param {string} code    Stable machine-readable code, e.g. "GRAMMAR_NOT_FOUND"
   * @param {string} message Human-readable description shown to the user
   * @param {*}      [details] Optional structured context (e.g. validation errors)
   */
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** 400 — malformed or semantically invalid request payload. */
  static badRequest(code, message, details) {
    return new HttpError(400, code, message, details);
  }

  /** 404 — the requested resource does not exist. */
  static notFound(code, message, details) {
    return new HttpError(404, code, message, details);
  }
}
