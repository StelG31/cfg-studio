/**
 * server.js
 * -------------------------------------------------------------------------
 * Purpose:
 *   Production entry point. Loads environment configuration, brings the
 *   database schema up to date, starts the HTTP server built in app.js and
 *   installs graceful-shutdown handlers.
 *
 *   Separation of concerns: app.js builds the Express app (testable with
 *   supertest, no sockets involved); this file is the only place that
 *   actually binds a port.
 *
 *   Import order is load-bearing: 'dotenv/config' must stay FIRST. ES module
 *   imports are evaluated in source order, and models/db.js reads
 *   DATABASE_URL while app.js's module graph is being evaluated on the line
 *   below. Swapping these two would break startup on every machine that
 *   keeps its configuration in .env.
 */

import 'dotenv/config';
import app from './app.js';
import { migrate } from './models/migrate.js';
import { close as closeDatabase } from './models/db.js';

const port = Number(process.env.PORT) || 3000;

// Migrate BEFORE listening. A process that accepted traffic against a schema
// it had not verified would answer real users with 500s; failing here means
// the deploy is marked failed and the previous version keeps serving.
try {
  await migrate();
} catch (err) {
  console.error('[startup] Database migration failed — not starting the server.');
  console.error(err.message);
  process.exit(1);
}

const server = app.listen(port, () => {
  console.log(`CFG Studio listening on http://localhost:${port} (${process.env.NODE_ENV || 'development'})`);
});

let shuttingDown = false;

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, release the database pool, then exit. Render (and any container
 * platform) sends SIGTERM on redeploy; handling it avoids dropped requests
 * and leaves no connection slots occupied on a free-tier database that has
 * very few of them.
 *
 * The guard matters now that shutdown is asynchronous: a second Ctrl-C would
 * otherwise start a parallel run and close the server twice.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down gracefully...`);

  // Safety net: force-exit if connections refuse to drain. unref() does not
  // stop the timer firing — it only stops the timer from being the reason
  // the process stays alive, which is exactly the case it exists for.
  const forceExit = setTimeout(() => {
    console.error('[shutdown] Timed out after 10s — forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeDatabase();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] Failed to shut down cleanly:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
