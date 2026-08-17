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

  /**
   * 401 — the caller has not proved who they are. Distinct from 403: the
   * remedy is to sign in, so the client shows the login screen rather than
   * telling the user they are not allowed.
   */
  static unauthorized(code, message, details) {
    return new HttpError(401, code, message, details);
  }

  /**
   * 403 — the caller is authenticated but the action is outside their
   * jurisdiction. Only ever used for targets the caller is allowed to SEE;
   * anything else is a 404, so that a probe cannot map out resources it has
   * no business knowing exist.
   */
  static forbidden(code, message, details) {
    return new HttpError(403, code, message, details);
  }

  /** 404 — the requested resource does not exist. */
  static notFound(code, message, details) {
    return new HttpError(404, code, message, details);
  }

  /** 409 — the request collides with existing state (e.g. a taken username). */
  static conflict(code, message, details) {
    return new HttpError(409, code, message, details);
  }

  /**
   * 503 — the request was fine, but the server is missing something it needs
   * to fulfil it. Distinct from a 500 on purpose: nothing is broken and there
   * is no bug to hunt, an operator simply has to finish configuring the
   * deployment.
   */
  static serviceUnavailable(code, message, details) {
    return new HttpError(503, code, message, details);
  }
}
