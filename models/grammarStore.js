/**
 * models/grammarStore.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The persistence layer of CFG Studio: one JSON file per saved grammar
 *   under DATA_DIR (default ./data/grammars). This is the ONLY module in
 *   the project that touches the filesystem for user data — swapping the
 *   storage engine (e.g. for SQLite) means replacing this file and nothing
 *   else.
 *
 *   Design notes:
 *     - Documents are written ATOMICALLY: the JSON is written to a
 *       temporary file first and then rename()d over the target. A crash
 *       mid-write can therefore never corrupt an existing grammar.
 *     - IDs are crypto.randomUUID() values and are strictly re-validated
 *       on every call (defence against path traversal: an id like
 *       "../../etc" can never reach path.join).
 *     - DATA_DIR is resolved on EVERY call (not cached at import time), so
 *       tests can point the store at a temporary directory simply by
 *       setting the environment variable.
 *     - Corrupt files are skipped (with a server-side warning) instead of
 *       failing the whole listing — one bad file must not take the
 *       collection down.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** UUIDs (and nothing else) are acceptable document ids. */
const ID_PATTERN = /^[a-f0-9-]{36}$/i;

/**
 * Shape-check an id BEFORE it is ever joined into a filesystem path — the
 * pattern admits only hex digits and dashes, so traversal fragments like
 * "../" can never reach path.join below.
 *
 * @param {*} id Candidate id.
 * @returns {boolean}
 */
export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function dataDir() {
  return path.resolve(process.cwd(), process.env.DATA_DIR || './data/grammars');
}

function fileFor(id) {
  return path.join(dataDir(), `${id}.json`);
}

async function ensureDir() {
  await fs.mkdir(dataDir(), { recursive: true });
}

/**
 * Write JSON atomically: temp file + rename (rename replaces the target on
 * both POSIX and Windows). Because the target file is switched in a single
 * filesystem operation, a crash mid-write can only ever leave a stray .tmp
 * file behind — never a half-written grammar.
 *
 * @param {string} filePath Final destination path.
 * @param {object} data     JSON-serializable document.
 */
async function writeAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

/* ------------------------------------------------------------------------ */
/* CRUD interface                                                            */
/* ------------------------------------------------------------------------ */

/**
 * List every stored grammar as lightweight metadata (the full production
 * list stays on disk), newest first.
 */
export async function list() {
  await ensureDir();
  const entries = await fs.readdir(dataDir());
  const documents = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dataDir(), entry), 'utf8');
      const doc = JSON.parse(raw);
      documents.push({
        id: doc.id,
        name: doc.name,
        description: doc.description ?? '',
        variableCount: doc.variables?.length ?? 0,
        terminalCount: doc.terminals?.length ?? 0,
        productionCount: doc.productions?.length ?? 0,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    } catch (err) {
      // A corrupt file is a data problem, not a service outage.
      console.warn(`[grammarStore] Skipping unreadable file ${entry}: ${err.message}`);
    }
  }

  return documents.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** @returns {Promise<object|null>} the full document, or null if absent. */
export async function get(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Persist a new grammar.
 *
 * @param {object} grammar A normalized grammar (the service validated it).
 * @returns {Promise<object>} the stored document — the grammar plus
 *          { id: randomUUID, createdAt, updatedAt } (ISO timestamps).
 */
export async function create(grammar) {
  await ensureDir();
  const now = new Date().toISOString();
  const doc = { id: crypto.randomUUID(), ...grammar, createdAt: now, updatedAt: now };
  await writeAtomic(fileFor(doc.id), doc);
  return doc;
}

/**
 * Replace the grammar content of an existing document (id and createdAt
 * are preserved, updatedAt is bumped).
 * @returns {Promise<object|null>} the updated document, or null if absent.
 */
export async function update(id, grammar) {
  const existing = await get(id);
  if (existing === null) return null;

  const doc = {
    ...grammar,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await writeAtomic(fileFor(id), doc);
  return doc;
}

/** @returns {Promise<boolean>} true if a document was deleted. */
export async function remove(id) {
  if (!isValidId(id)) return false;
  try {
    await fs.unlink(fileFor(id));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
