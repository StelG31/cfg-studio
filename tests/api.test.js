/**
 * tests/api.test.js
 * ---------------------------------------------------------------------------
 * HTTP-level tests for the Express API using supertest (no sockets — the
 * app object is exercised in-process). Persistence runs against the
 * throw-away PostgreSQL schema that tests/setup/globalSetup.js created and
 * migrated, so tests never touch development data.
 *
 * Grammar endpoints require a session since the accounts phase, so the CRUD
 * tests below run through `agent` — a supertest client that keeps the login
 * cookie. The compute and examples endpoints are used WITHOUT it on purpose:
 * they are open to anonymous callers, and these tests are what says so.
 */

import request from 'supertest';

import { anbn, arithmetic } from './fixtures/grammars.js';
import { TEST_ADMIN } from './setup/testDb.js';
import { validateGrammar } from '../core/validator.js';
import { createGrammar } from '../core/grammar.js';

let app;
let db;
let agent;

beforeAll(async () => {
  // DATABASE_URL already points at the test schema. The import below must
  // stay DYNAMIC: models/db.js reads that variable while it is being
  // evaluated, not when it is called, so a static import at the top of this
  // file would run before the environment was ready.
  ({ default: app } = await import('../app.js'));
  // The same module instance the app uses — Jest keeps one module registry
  // per test file.
  db = await import('../models/db.js');

  agent = request.agent(app);
  const signIn = await agent
    .post('/api/auth/login')
    .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });
  expect(signIn.status).toBe(200);
});

afterAll(async () => {
  // Release the pool the app opened, or Jest hangs on an open handle.
  await db.close();
});

describe('grammar CRUD round-trip', () => {
  let createdId;

  test('POST /api/grammars persists a valid grammar', async () => {
    const response = await agent.post('/api/grammars').send({ grammar: anbn() });
    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^[a-f0-9-]{36}$/i);
    expect(response.body.createdAt).toBeDefined();
    expect(response.body.productions).toHaveLength(2);
    createdId = response.body.id;
  });

  test('GET /api/grammars lists the stored grammar as metadata', async () => {
    const response = await agent.get('/api/grammars');
    expect(response.status).toBe(200);
    const entry = response.body.find((doc) => doc.id === createdId);
    expect(entry).toBeDefined();
    expect(entry.productionCount).toBe(2);
    expect(entry.productions).toBeUndefined(); // metadata only
  });

  test('GET /api/grammars/:id returns the full document', async () => {
    const response = await agent.get(`/api/grammars/${createdId}`);
    expect(response.status).toBe(200);
    expect(response.body.productions).toHaveLength(2);
  });

  test('PUT /api/grammars/:id replaces the content and bumps updatedAt', async () => {
    const changed = { ...arithmetic(), name: 'Renamed grammar' };
    const response = await agent.put(`/api/grammars/${createdId}`).send({ grammar: changed });
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Renamed grammar');
    expect(response.body.id).toBe(createdId); // id survives updates
    expect(response.body.productions).toHaveLength(6);
  });

  test('DELETE /api/grammars/:id removes the document', async () => {
    const del = await agent.delete(`/api/grammars/${createdId}`);
    expect(del.status).toBe(204);
    const gone = await agent.get(`/api/grammars/${createdId}`);
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
    const response = await agent.post('/api/grammars').send({ grammar: broken });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('GRAMMAR_INVALID');
    expect(response.body.error.details.errors.map((e) => e.code)).toContain('START_NOT_DECLARED');
  });

  test('structurally malformed payloads are rejected', async () => {
    const response = await agent.post('/api/grammars').send({ grammar: { variables: 'S' } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_GRAMMAR_FORMAT');
  });

  test('ill-formatted ids are rejected before touching the filesystem', async () => {
    const response = await agent.get('/api/grammars/not-a-uuid');
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

describe('CYK endpoint', () => {
  test('POST /api/cyk runs the algorithm over a CNF grammar', async () => {
    const cnfGrammar = {
      variables: ['S', 'A', 'B'],
      terminals: ['a', 'b'],
      startSymbol: 'S',
      productions: [
        { left: 'S', right: ['A', 'B'] },
        { left: 'A', right: ['a'] },
        { left: 'B', right: ['b'] },
      ],
    };
    const yes = await request(app).post('/api/cyk').send({ grammar: cnfGrammar, input: 'ab' });
    expect(yes.status).toBe(200);
    expect(yes.body.accepted).toBe(true);
    expect(yes.body.steps.at(-1).type).toBe('verdict');

    const no = await request(app).post('/api/cyk').send({ grammar: cnfGrammar, input: 'ba' });
    expect(no.body.accepted).toBe(false);
  });

  test('POST /api/cyk rejects a non-CNF grammar with the stable code', async () => {
    const response = await request(app).post('/api/cyk').send({ grammar: anbn(), input: 'ab' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('GRAMMAR_NOT_CNF');
  });

  test('POST /api/cyk rejects characters outside the alphabet', async () => {
    const cnfGrammar = {
      variables: ['S'],
      terminals: ['a'],
      startSymbol: 'S',
      productions: [{ left: 'S', right: ['a'] }],
    };
    const response = await request(app).post('/api/cyk').send({ grammar: cnfGrammar, input: 'ax' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT_CHAR');
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
