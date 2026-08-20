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

describe('Earley endpoint', () => {
  // Anonymous like the CYK tests above, and for the same reason: running these
  // without the logged-in `agent` is what asserts the endpoint is open.

  test('POST /api/earley parses a grammar CYK would refuse', async () => {
    // The point of the endpoint in one test. anbn() is S -> a S b | ε: valid,
    // but not in Chomsky Normal Form, so /api/cyk rejects it outright (the
    // test above pins that). Earley takes it as written.
    const grammar = anbn();

    const refused = await request(app).post('/api/cyk').send({ grammar, input: 'aabb' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('GRAMMAR_NOT_CNF');

    const yes = await request(app).post('/api/earley').send({ grammar, input: 'aabb' });
    expect(yes.status).toBe(200);
    expect(yes.body.accepted).toBe(true);
    expect(yes.body.steps.at(-1).type).toBe('verdict');

    const no = await request(app).post('/api/earley').send({ grammar, input: 'abab' });
    expect(no.status).toBe(200);
    expect(no.body.accepted).toBe(false);
  });

  test('POST /api/earley returns the chart the browser would build', async () => {
    // n + 1 columns is the defining shape of the result (docs/algorithms.md
    // §6). Asserting it here is what says the HTTP path returns the same
    // structure the shared core produces in the browser, not a summary of it.
    const response = await request(app)
      .post('/api/earley')
      .send({ grammar: arithmetic(), input: 'a+a*a' });
    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(true);
    expect(response.body.n).toBe(5);
    expect(response.body.chart).toHaveLength(6);
    expect(response.body.startSymbol).toBe('E');
  });

  test('POST /api/earley rejects an invalid grammar with the full finding list', async () => {
    const broken = createGrammar({
      variables: ['S'],
      terminals: ['a'],
      startSymbol: 'Q', // undeclared start symbol
      productions: [{ left: 'S', right: ['a'] }],
    });
    const response = await request(app).post('/api/earley').send({ grammar: broken, input: 'a' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('GRAMMAR_INVALID');
    expect(response.body.error.details.errors.map((e) => e.code)).toContain('START_NOT_DECLARED');
  });

  test('POST /api/earley rejects characters outside the alphabet', async () => {
    const response = await request(app).post('/api/earley').send({ grammar: anbn(), input: 'axb' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT_CHAR');
  });

  test('POST /api/earley rejects an input past the length cap', async () => {
    const response = await request(app)
      .post('/api/earley')
      .send({ grammar: anbn(), input: 'a'.repeat(31) });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INPUT_TOO_LONG');
  });

  test('POST /api/earley rejects a non-string input', async () => {
    // MISSING_INPUT, not the core's INVALID_INPUT: the service guards the type
    // before runEarley is ever called, so EarleyError('INVALID_INPUT') cannot
    // surface here. That is not an oversight but the CYK pattern mirrored
    // exactly — CykError('INVALID_INPUT') is unreachable through /api/cyk for
    // the identical reason. The core guard is covered in tests/earley.test.js,
    // where it IS reachable.
    const response = await request(app).post('/api/earley').send({ grammar: anbn(), input: 42 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MISSING_INPUT');
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

/* ------------------------------------------------------------------------ */
/* Test strings saved with a grammar                                         */
/* ------------------------------------------------------------------------ */

describe('test strings persist with the grammar', () => {
  test('POST stores them and GET returns them', async () => {
    const grammar = { ...anbn(), testStrings: { accept: ['', 'ab', 'aabb'], reject: ['a', 'ba'] } };
    const created = await agent.post('/api/grammars').send({ grammar });
    expect(created.status).toBe(201);
    expect(created.body.testStrings).toEqual({ accept: ['', 'ab', 'aabb'], reject: ['a', 'ba'] });

    const fetched = await agent.get(`/api/grammars/${created.body.id}`);
    expect(fetched.status).toBe(200);
    // The empty string in particular has to come back: it is the epsilon
    // test case, and the easiest one to lose to a stray filter.
    expect(fetched.body.testStrings).toEqual({ accept: ['', 'ab', 'aabb'], reject: ['a', 'ba'] });
  });

  test('PUT replaces them', async () => {
    const created = await agent
      .post('/api/grammars')
      .send({ grammar: { ...anbn(), testStrings: { accept: ['ab'], reject: [] } } });

    const updated = await agent
      .put(`/api/grammars/${created.body.id}`)
      .send({ grammar: { ...anbn(), testStrings: { accept: ['aabb'], reject: ['b'] } } });

    expect(updated.status).toBe(200);
    expect(updated.body.testStrings).toEqual({ accept: ['aabb'], reject: ['b'] });
  });

  test('a grammar saved without them reads back with empty lists', async () => {
    // The backward-compatibility guarantee: rows written before the column
    // was ever read still answer with the shape every client expects.
    const created = await agent.post('/api/grammars').send({ grammar: anbn() });
    expect(created.status).toBe(201);
    expect(created.body.testStrings).toEqual({ accept: [], reject: [] });

    const fetched = await agent.get(`/api/grammars/${created.body.id}`);
    expect(fetched.body.testStrings).toEqual({ accept: [], reject: [] });
  });

  test('the listing stays metadata-only', async () => {
    await agent
      .post('/api/grammars')
      .send({ grammar: { ...anbn(), testStrings: { accept: ['ab'], reject: [] } } });
    const response = await agent.get('/api/grammars');
    expect(response.status).toBe(200);
    for (const entry of response.body) expect(entry.testStrings).toBeUndefined();
  });
});

describe('test string guards (server-side, whatever the browser checked)', () => {
  test('too many in total is refused', async () => {
    const many = Array.from({ length: 26 }, (_, i) => 'a'.repeat((i % 20) + 1));
    const response = await agent.post('/api/grammars').send({
      grammar: { ...anbn(), testStrings: { accept: many, reject: many } },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('GRAMMAR_TOO_LARGE');
  });

  test('a string longer than the parsers accept is refused', async () => {
    const response = await agent.post('/api/grammars').send({
      grammar: { ...anbn(), testStrings: { accept: ['a'.repeat(31)], reject: [] } },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TEST_STRING_TOO_LONG');
  });

  test('the same string in both lists is refused', async () => {
    const response = await agent.post('/api/grammars').send({
      grammar: { ...anbn(), testStrings: { accept: ['ab'], reject: ['ab'] } },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TEST_STRINGS_CONFLICT');
  });

  test('a malformed testStrings field is refused', async () => {
    const response = await agent
      .post('/api/grammars')
      .send({ grammar: { ...anbn(), testStrings: { accept: 'ab' } } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_GRAMMAR_FORMAT');
  });
});
