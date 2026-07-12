/**
 * server.js
 * -------------------------------------------------------------------------
 * Purpose:
 *   Production entry point. Loads environment configuration, starts the
 *   HTTP server built in app.js and installs graceful-shutdown handlers.
 *
 *   Separation of concerns: app.js builds the Express app (testable with
 *   supertest, no sockets involved); this file is the only place that
 *   actually binds a port.
 */

import 'dotenv/config';
import app from './app.js';

const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  console.log(`CFG Studio listening on http://localhost:${port} (${process.env.NODE_ENV || 'development'})`);
});

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, then exit. Render (and any container platform) sends SIGTERM on
 * redeploy; handling it avoids dropped requests.
 */
function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully...`);
  server.close(() => process.exit(0));
  // Safety net: force-exit if connections refuse to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
