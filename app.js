/**
 * app.js
 * -------------------------------------------------------------------------
 * Purpose:
 *   Assembles the Express application: security middleware, static asset
 *   mounts, API routes and the central error handlers.
 *
 *   The app is exported WITHOUT calling listen() so that:
 *     - server.js can start it for real use, and
 *     - Jest/supertest can import it and issue requests in-process.
 *
 * Static asset strategy:
 *   /            -> views/index.html (the single-page UI)
 *   /css, /js    -> public/           (our own frontend assets)
 *   /core        -> core/             (the shared algorithm modules — the
 *                                      SAME files the server and Jest use;
 *                                      the browser imports them as native
 *                                      ES modules)
 *   /vendor/*    -> node_modules/...  (Bootstrap served locally: no CDN,
 *                                      works offline, one dependency source)
 */

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const isProduction = () => process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

// Sensible security headers (CSP defaults allow only same-origin scripts,
// which is exactly how this app is built — no inline scripts, no CDNs).
app.use(helmet());

// Gzip/deflate response compression for production performance.
app.use(compression());

// JSON body parsing with a hard size limit: grammars are tiny documents,
// so anything above 200 KB is either a mistake or abuse.
app.use(express.json({ limit: '200kb' }));

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

// Cache aggressively in production; always revalidate during development.
const staticOptions = { maxAge: isProduction() ? '1d' : 0 };

app.use(express.static(path.join(__dirname, 'public'), staticOptions));
app.use('/core', express.static(path.join(__dirname, 'core'), staticOptions));
app.use(
  '/vendor/bootstrap',
  express.static(path.join(__dirname, 'node_modules/bootstrap/dist'), staticOptions)
);
app.use(
  '/vendor/bootstrap-icons',
  express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font'), staticOptions)
);

// ---------------------------------------------------------------------------
// Pages & health check
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Used by the deployment platform (Render) to verify the service is alive.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// 404 + central error handling
// ---------------------------------------------------------------------------

// Anything that fell through the routes above does not exist. API calls get
// a JSON error; page requests get a friendly 404 page.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No API endpoint at ${req.method} ${req.path}` },
    });
  } else {
    res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
  }
});

// Central error handler: every thrown HttpError (and any unexpected error)
// ends up here and is serialised into one consistent shape. Stack traces are
// logged server-side but never leaked to clients in production.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body-parser produces its own error type for malformed JSON payloads.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' },
    });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body exceeds the 200 KB limit.' },
    });
  }

  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message =
    status === 500 && isProduction()
      ? 'An unexpected server error occurred.' // hide internals in production
      : err.message || 'An unexpected server error occurred.';

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.path}:`, err);
  }

  res.status(status).json({
    error: { code, message, ...(err.details !== undefined ? { details: err.details } : {}) },
  });
});

export default app;
