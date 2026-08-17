/**
 * utils/sessionCookie.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The one place that knows how a session token travels between browser and
 *   server. The middleware reads it, the auth controller writes and clears
 *   it; neither spells out a cookie flag of its own, so the security
 *   properties below cannot drift apart between the read and write paths.
 *
 *   Flag choices, and why:
 *     - httpOnly  script cannot read the cookie, so an XSS bug cannot walk
 *                 off with a live credential.
 *     - sameSite  'lax' — the cookie is not attached to cross-site POSTs,
 *                 which is what makes CSRF against this API a non-issue
 *                 without a token scheme. 'strict' would break following a
 *                 link into the app while signed in, for no extra safety
 *                 here: every state change is a POST/PUT/DELETE.
 *     - secure    production only. Demanding TLS on http://localhost would
 *                 mean the cookie is silently dropped in development.
 *
 *   Reading is a hand-rolled parse of the Cookie header rather than
 *   cookie-parser: one dependency avoided for eight lines, and the project
 *   admits no dependency it does not need.
 */

/** Cookie name. Changing it signs every existing session out. */
export const SESSION_COOKIE = 'cfg_session';

/**
 * How long a session lives, from the moment it is created — an ABSOLUTE
 * expiry, never extended by use. Sliding expiry would mean a database write
 * on every authenticated request, and revocation here is already immediate
 * (the row is deleted), so there is nothing to buy with that cost.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Extract the session token from a request.
 *
 * @param {import('express').Request} req
 * @returns {string|null} the raw token, or null when the cookie is absent.
 */
export function readSessionToken(req) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || header === '') return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;

    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      // A malformed percent-escape is not a token. Treat it as no cookie
      // rather than letting decodeURIComponent throw out of the middleware.
      return null;
    }
  }
  return null;
}

/** The flags shared by setting and clearing, so the two always agree. */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

/**
 * @param {import('express').Response} res
 * @param {string} token Raw session token (never its hash — that is what the
 *        database stores instead).
 */
export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_MS });
}

/**
 * Remove the cookie. The session row is deleted separately: the cookie is
 * only the client's copy, and a browser that ignores this still loses access
 * because the server-side row is gone.
 *
 * @param {import('express').Response} res
 */
export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}
