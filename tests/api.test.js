/**
 * tests/api.test.js
 * ---------------------------------------------------------------------------
 * HTTP-level tests for the Express API using supertest (no sockets — the
 * app object is exercised in-process). Persistence runs against a fresh
 * temporary DATA_DIR so tests never touch real user data.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

import { anbn, arithmetic } from './fixtures/grammars.js';
import { validateGrammar } from '../core/validator.js';
import { createGrammar } from '../core/grammar.js';

let app;
let tempDir;

beforeAll(async () => {
  // The store resolves DATA_DIR on every call, so pointing the environment
  // at a temp directory BEFORE the first request is all isolation needs.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-studio-test-'));
  process.env.DATA_DIR = tempDir;
  ({ default: app } = await import('../app.js'));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('grammar CRUD round-trip', () => {
  let createdId;

  test('POST /api/grammars persists a valid grammar', async () => {
    const response = await request(app).post('/api/grammars').send({ grammar: anbn() });
    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^[a-f0-9-]{36}$/i);
    expect(response.body.createdAt).toBeDefined();
    expect(response.body.productions).toHaveLength(2);
    createdId = response.body.id;
  });

  test('GET /api/grammars lists the stored grammar as metadata', async () => {
    const response = await request(app).get('/api/grammars');
    expect(response.status).toBe(200);
    const entry = response.body.find((doc) => doc.id === createdId);
    expect(entry).toBeDefined();
    expect(entry.productionCount).toBe(2);
    expect(entry.productions).toBeUndefined(); // metadata only
  });

  test('GET /api/grammars/:id returns the full document', async () => {
    const response = await request(app).get(`/api/grammars/${createdId}`);
    expect(response.status).toBe(200);
    expect(response.body.productions).toHaveLength(2);
  });

  test('PUT /api/grammars/:id replaces the content and bumps updatedAt', async () => {
    const changed = { ...arithmetic(), name: 'Renamed grammar' };
    const response = await request(app)
      .put(`/api/grammars/${createdId}`)
      .send({ grammar: changed });
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Renamed grammar');
    expect(response.body.id).toBe(createdId); // id survives updates
    expect(response.body.productions).toHaveLength(6);
  });

  test('DELETE /api/grammars/:id removes the document', async () => {
    const del = await request(app).delete(`/api/grammars/${createdId}`);
    expect(del.status).toBe(204);
    const gone = await request(app).get(`/api/grammars/${createdId}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('GRAMMAR_NOT_FOUND');
  });
});

describe('persistence guards', () => {
  test('invalid grammars are rejected with the full finding list', async () => {
    const broken = createGrammar({
      variables: ['S'],
      terminals: ['a'],
      startSymbol: 'Q', // undeclared start symbol
      productions: [{ left: 'S', right: ['a'] }],
    });
    const response = await request(app).post('/api/grammars').send({ grammar: broken });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('GRAMMAR_INVALID');
    expect(response.body.error.details.errors.map((e) => e.code)).toContain('START_NOT_DECLARED');
  });

  test('structurally malformed payloads are rejected', async () => {
    const response = await request(app).post('/api/grammars').send({ grammar: { variables: 'S' } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_GRAMMAR_FORMAT');
  });

  test('ill-formatted ids are rejected before touching the filesystem', async () => {
    const response = await request(app).get('/api/grammars/not-a-uuid');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_ID');
  });
});

describe('validation endpoint', () => {
  test('POST /api/validate returns findings for a broken grammar', async () => {
    const response = await request(app)
      .post('/api/validate')
      .send({ grammar: { variables: ['S'], terminals: [], startSymbol: '', productions: [] } });
    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);
    expect(response.body.errors.map((e) => e.code)).toContain('MISSING_START');
  });
});

describe('sample grammars', () => {
  test('GET /api/examples serves at least the four required samples', async () => {
    const response = await request(app).get('/api/examples');
    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThanOrEqual(4);
    const names = response.body.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Balanced Parentheses',
        'aⁿbⁿ',
        'Arithmetic Expressions',
        'Simple Expression Grammar',
      ])
    );
  });

  test('every shipped sample passes the shared validator', async () => {
    const response = await request(app).get('/api/examples');
    for (const sample of response.body) {
      const result = validateGrammar(createGrammar(sample));
      expect({ name: sample.name, errors: result.errors }).toEqual({
        name: sample.name,
        errors: [],
      });
    }
  });

  test('every sample declares accept and reject test strings', async () => {
    const response = await request(app).get('/api/examples');
    for (const sample of response.body) {
      expect(sample.testStrings.accept.length).toBeGreaterThan(0);
      expect(sample.testStrings.reject.length).toBeGreaterThan(0);
    }
  });
});

describe('error handling', () => {
  test('unknown API routes yield a JSON 404', async () => {
    const response = await request(app).get('/api/definitely-not-a-route');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  test('malformed JSON bodies yield a descriptive 400', async () => {
    const response = await request(app)
      .post('/api/validate')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });
});
