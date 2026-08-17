/**
 * tests/authorization.test.js
 * ---------------------------------------------------------------------------
 * The permission matrix, walked exhaustively.
 *
 * Three layers, each proving something the others cannot:
 *
 *   1. THE TABLE — every (actor, action, target) triple against canAccess()
 *      directly. No database, no HTTP. This is the only way to know the
 *      matrix is actually implemented rather than approximately implemented:
 *      a test that exercises the endpoints someone remembered to write proves
 *      nothing about the combination they forgot.
 *
 *   2. SCOPE EQUIVALENCE — the list queries return exactly the rows canAccess
 *      admits one at a time. A listing cannot ask canAccess per row (it is a
 *      WHERE clause), so this is what stops the SQL filter and the policy
 *      drifting apart. It runs against the real database with real rows
 *      rather than a re-implementation of the filter in JavaScript, because a
 *      second implementation would only prove the two copies agree.
 *
 *   3. WIRING — the same rules over HTTP, including the 404-before-403 split.
 *      A perfect policy function that no route consults protects nothing.
 */

import request from 'supertest';

import { anbn } from './fixtures/grammars.js';
import { TEST_ADMIN } from './setup/testDb.js';
import { canAccess, ACTIONS } from '../services/userService.js';

let app;
let db;

/**
 * Ids that look real, for the pure table. canAccess never touches the
 * database, so these need only be distinct and UUID-shaped.
 */
const ID = {
  admin: '00000000-0000-4000-8000-000000000001',
  teacherA: '00000000-0000-4000-8000-00000000000a',
  teacherB: '00000000-0000-4000-8000-00000000000b',
  studentA1: '00000000-0000-4000-8000-0000000000a1',
  studentA2: '00000000-0000-4000-8000-0000000000a2',
  studentB1: '00000000-0000-4000-8000-0000000000b1',
};

const ACTORS = {
  anonymous: null,
  admin: { id: ID.admin, username: 'admin', role: 'admin', teacherId: null },
  teacherA: { id: ID.teacherA, username: 'teacher-a', role: 'teacher', teacherId: null },
  teacherB: { id: ID.teacherB, username: 'teacher-b', role: 'teacher', teacherId: null },
  studentA1: { id: ID.studentA1, username: 'student-a1', role: 'student', teacherId: ID.teacherA },
  studentB1: { id: ID.studentB1, username: 'student-b1', role: 'student', teacherId: ID.teacherB },
};

/** User targets, by the same names. */
const USER_TARGET = {
  admin: { id: ID.admin, role: 'admin', teacherId: null },
  teacherA: { id: ID.teacherA, role: 'teacher', teacherId: null },
  teacherB: { id: ID.teacherB, role: 'teacher', teacherId: null },
  studentA1: { id: ID.studentA1, role: 'student', teacherId: ID.teacherA },
  studentA2: { id: ID.studentA2, role: 'student', teacherId: ID.teacherA },
  studentB1: { id: ID.studentB1, role: 'student', teacherId: ID.teacherB },
};

/** Grammar targets: one owned by each fixture user. */
const GRAMMAR_TARGET = {
  ofAdmin: { ownerId: ID.admin, ownerTeacherId: null },
  ofTeacherA: { ownerId: ID.teacherA, ownerTeacherId: null },
  ofTeacherB: { ownerId: ID.teacherB, ownerTeacherId: null },
  ofStudentA1: { ownerId: ID.studentA1, ownerTeacherId: ID.teacherA },
  ofStudentB1: { ownerId: ID.studentB1, ownerTeacherId: ID.teacherB },
};

beforeAll(async () => {
  // Dynamic, so DATABASE_URL is already pointing at the test schema when
  // models/db.js is evaluated. See tests/api.test.js for the full reasoning.
  ({ default: app } = await import('../app.js'));
  db = await import('../models/db.js');
});

/* ========================================================================= */
/* 1. The table                                                              */
/* ========================================================================= */

describe('canAccess — anonymous callers', () => {
  test.each(ACTIONS)('%s is refused without an actor', (action) => {
    expect(canAccess(null, action, USER_TARGET.studentA1)).toBe(false);
    expect(canAccess(undefined, action, GRAMMAR_TARGET.ofStudentA1)).toBe(false);
  });
});

describe('canAccess — fails closed', () => {
  test('an unknown action is denied for every actor', () => {
    for (const actor of Object.values(ACTORS)) {
      expect(canAccess(actor, 'grammar:destroy-everything', GRAMMAR_TARGET.ofAdmin)).toBe(false);
      expect(canAccess(actor, '', null)).toBe(false);
    }
  });

  test('an actor with an unrecognised role is denied', () => {
    const impostor = { id: ID.admin, username: 'x', role: 'superadmin', teacherId: null };
    for (const action of ACTIONS) {
      expect(canAccess(impostor, action, USER_TARGET.studentA1)).toBe(false);
    }
  });

  test('row-level actions are denied when the target is missing', () => {
    const rowLevel = ACTIONS.filter(
      (a) => !['user:list', 'grammar:create', 'algorithm:use'].includes(a)
    );
    for (const action of rowLevel) {
      expect(canAccess(ACTORS.admin, action, null)).toBe(false);
    }
  });
});

/**
 * The matrix proper. Every row is [actor, action, target, expected] and the
 * set below covers each role against each action against each target type.
 */
const MATRIX = [
  /* --- Create teacher: admin only --------------------------------------- */
  ['admin', 'user:create', { role: 'teacher', teacherId: null }, true],
  ['teacherA', 'user:create', { role: 'teacher', teacherId: null }, false],
  ['studentA1', 'user:create', { role: 'teacher', teacherId: null }, false],

  /* --- Create student: admin anywhere, teacher only under themselves ----- */
  ['admin', 'user:create', { role: 'student', teacherId: ID.teacherA }, true],
  ['teacherA', 'user:create', { role: 'student', teacherId: ID.teacherA }, true],
  ['teacherA', 'user:create', { role: 'student', teacherId: ID.teacherB }, false],
  ['teacherA', 'user:create', { role: 'student', teacherId: null }, false],
  ['studentA1', 'user:create', { role: 'student', teacherId: ID.teacherA }, false],

  /* --- Nobody creates an administrator ---------------------------------- */
  ['admin', 'user:create', { role: 'admin', teacherId: null }, false],
  ['teacherA', 'user:create', { role: 'admin', teacherId: null }, false],
  ['studentA1', 'user:create', { role: 'admin', teacherId: null }, false],

  /* --- List users -------------------------------------------------------- */
  ['admin', 'user:list', null, true],
  ['teacherA', 'user:list', null, true],
  ['studentA1', 'user:list', null, false],

  /* --- Read a user ------------------------------------------------------- */
  ['admin', 'user:read', USER_TARGET.studentB1, true],
  ['admin', 'user:read', USER_TARGET.teacherB, true],
  ['teacherA', 'user:read', USER_TARGET.studentA1, true],
  ['teacherA', 'user:read', USER_TARGET.studentB1, false],
  ['teacherA', 'user:read', USER_TARGET.teacherB, false],
  ['teacherA', 'user:read', USER_TARGET.teacherA, true], // themselves
  ['teacherA', 'user:read', USER_TARGET.admin, false],
  ['studentA1', 'user:read', USER_TARGET.studentA1, true], // themselves
  ['studentA1', 'user:read', USER_TARGET.studentA2, false],
  ['studentA1', 'user:read', USER_TARGET.teacherA, false],

  /* --- Delete a user ----------------------------------------------------- */
  ['admin', 'user:delete', USER_TARGET.teacherA, true],
  ['admin', 'user:delete', USER_TARGET.studentB1, true],
  ['admin', 'user:delete', USER_TARGET.admin, false], // never yourself
  ['teacherA', 'user:delete', USER_TARGET.studentA1, true],
  ['teacherA', 'user:delete', USER_TARGET.studentA2, true],
  ['teacherA', 'user:delete', USER_TARGET.studentB1, false],
  ['teacherA', 'user:delete', USER_TARGET.teacherB, false],
  ['teacherA', 'user:delete', USER_TARGET.teacherA, false], // never yourself
  ['teacherA', 'user:delete', USER_TARGET.admin, false],
  ['studentA1', 'user:delete', USER_TARGET.studentA2, false],
  ['studentA1', 'user:delete', USER_TARGET.teacherA, false],
  ['studentA1', 'user:delete', USER_TARGET.studentA1, false],

  /* --- Reset someone's password ------------------------------------------ */
  ['admin', 'user:resetPassword', USER_TARGET.teacherB, true],
  ['admin', 'user:resetPassword', USER_TARGET.studentB1, true],
  ['teacherA', 'user:resetPassword', USER_TARGET.studentA1, true],
  ['teacherA', 'user:resetPassword', USER_TARGET.studentB1, false],
  ['teacherA', 'user:resetPassword', USER_TARGET.teacherB, false],
  ['teacherA', 'user:resetPassword', USER_TARGET.admin, false],
  ['studentA1', 'user:resetPassword', USER_TARGET.studentA2, false],
  ['studentA1', 'user:resetPassword', USER_TARGET.teacherA, false],

  /* --- Change your own password ------------------------------------------ */
  ['admin', 'user:changeOwnPassword', { id: ID.admin }, true],
  ['admin', 'user:changeOwnPassword', { id: ID.teacherA }, false],
  ['teacherA', 'user:changeOwnPassword', { id: ID.teacherA }, true],
  ['teacherA', 'user:changeOwnPassword', { id: ID.studentA1 }, false],
  ['studentA1', 'user:changeOwnPassword', { id: ID.studentA1 }, true],
  ['studentA1', 'user:changeOwnPassword', { id: ID.studentA2 }, false],

  /* --- Create a grammar: everybody --------------------------------------- */
  ['admin', 'grammar:create', null, true],
  ['teacherA', 'grammar:create', null, true],
  ['studentA1', 'grammar:create', null, true],

  /* --- Read a grammar ---------------------------------------------------- */
  ['admin', 'grammar:read', GRAMMAR_TARGET.ofStudentB1, true],
  ['admin', 'grammar:read', GRAMMAR_TARGET.ofTeacherB, true],
  ['teacherA', 'grammar:read', GRAMMAR_TARGET.ofTeacherA, true],
  ['teacherA', 'grammar:read', GRAMMAR_TARGET.ofStudentA1, true], // own student
  ['teacherA', 'grammar:read', GRAMMAR_TARGET.ofStudentB1, false],
  ['teacherA', 'grammar:read', GRAMMAR_TARGET.ofTeacherB, false],
  ['teacherA', 'grammar:read', GRAMMAR_TARGET.ofAdmin, false],
  ['studentA1', 'grammar:read', GRAMMAR_TARGET.ofStudentA1, true],
  ['studentA1', 'grammar:read', GRAMMAR_TARGET.ofTeacherA, false],
  ['studentA1', 'grammar:read', GRAMMAR_TARGET.ofStudentB1, false],

  /* --- Update / delete a grammar: never someone else's ------------------- */
  ['admin', 'grammar:update', GRAMMAR_TARGET.ofStudentB1, true],
  ['admin', 'grammar:delete', GRAMMAR_TARGET.ofStudentB1, true],
  ['teacherA', 'grammar:update', GRAMMAR_TARGET.ofTeacherA, true],
  ['teacherA', 'grammar:delete', GRAMMAR_TARGET.ofTeacherA, true],
  // The asymmetry that matters: readable, but not writable.
  ['teacherA', 'grammar:update', GRAMMAR_TARGET.ofStudentA1, false],
  ['teacherA', 'grammar:delete', GRAMMAR_TARGET.ofStudentA1, false],
  ['teacherA', 'grammar:update', GRAMMAR_TARGET.ofStudentB1, false],
  ['studentA1', 'grammar:update', GRAMMAR_TARGET.ofStudentA1, true],
  ['studentA1', 'grammar:delete', GRAMMAR_TARGET.ofStudentA1, true],
  ['studentA1', 'grammar:update', GRAMMAR_TARGET.ofTeacherA, false],
  ['studentA1', 'grammar:delete', GRAMMAR_TARGET.ofStudentB1, false],

  /* --- Algorithms: everybody --------------------------------------------- */
  ['admin', 'algorithm:use', null, true],
  ['teacherA', 'algorithm:use', null, true],
  ['studentA1', 'algorithm:use', null, true],
];

describe('canAccess — the permission matrix', () => {
  test.each(MATRIX)('%s %s → %p is %p', (actorName, action, target, expected) => {
    expect(canAccess(ACTORS[actorName], action, target)).toBe(expected);
  });

  test('the matrix covers every action', () => {
    const covered = new Set(MATRIX.map(([, action]) => action));
    expect([...ACTIONS].sort()).toEqual([...covered].sort());
  });

  test('every role is exercised against every action', () => {
    for (const role of ['admin', 'teacherA', 'studentA1']) {
      const actions = new Set(
        MATRIX.filter(([actorName]) => actorName === role).map(([, action]) => action)
      );
      expect([...actions].sort()).toEqual([...ACTIONS].sort());
    }
  });
});

/* ========================================================================= */
/* Live fixtures for layers 2 and 3                                          */
/* ========================================================================= */

/** Everything created here is prefixed so afterAll can clean up precisely. */
const PREFIX = 'authz';
const PASSWORD = 'fixture-password';

/** Signed-in supertest clients, one per fixture user. */
const clients = {};
/** The real database rows, keyed the same way. */
const users = {};
/** One grammar per user: { owner: grammarId }. */
const grammars = {};

async function signIn(username, password) {
  const client = request.agent(app);
  const response = await client.post('/api/auth/login').send({ username, password });
  expect(response.status).toBe(200);
  return { client, user: response.body };
}

async function createUserAs(client, payload) {
  const response = await client.post('/api/users').send({ ...payload, password: PASSWORD });
  expect(response.status).toBe(201);
  return response.body;
}

async function saveGrammarAs(client, name) {
  const response = await client.post('/api/grammars').send({ grammar: { ...anbn(), name } });
  expect(response.status).toBe(201);
  return response.body.id;
}

beforeAll(async () => {
  const asAdmin = await signIn(TEST_ADMIN.username, TEST_ADMIN.password);
  clients.admin = asAdmin.client;
  users.admin = asAdmin.user;

  users.teacherA = await createUserAs(clients.admin, {
    username: `${PREFIX}-teacher-a`,
    role: 'teacher',
  });
  users.teacherB = await createUserAs(clients.admin, {
    username: `${PREFIX}-teacher-b`,
    role: 'teacher',
  });

  clients.teacherA = (await signIn(`${PREFIX}-teacher-a`, PASSWORD)).client;
  clients.teacherB = (await signIn(`${PREFIX}-teacher-b`, PASSWORD)).client;

  users.studentA1 = await createUserAs(clients.teacherA, {
    username: `${PREFIX}-student-a1`,
    role: 'student',
  });
  users.studentA2 = await createUserAs(clients.teacherA, {
    username: `${PREFIX}-student-a2`,
    role: 'student',
  });
  users.studentB1 = await createUserAs(clients.teacherB, {
    username: `${PREFIX}-student-b1`,
    role: 'student',
  });

  clients.studentA1 = (await signIn(`${PREFIX}-student-a1`, PASSWORD)).client;
  clients.studentA2 = (await signIn(`${PREFIX}-student-a2`, PASSWORD)).client;
  clients.studentB1 = (await signIn(`${PREFIX}-student-b1`, PASSWORD)).client;

  for (const name of ['teacherA', 'teacherB', 'studentA1', 'studentA2', 'studentB1']) {
    grammars[name] = await saveGrammarAs(clients[name], `${PREFIX} ${name}`);
  }
  // Scrypt runs once per user created and once per sign-in; well past Jest's
  // 5 s default for a single hook.
}, 60_000);

afterAll(async () => {
  // Delete only what this file made. test-admin must survive: every other
  // suite's grammars hang off it by ON DELETE CASCADE.
  await db.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}-%`]);
  await db.query('DELETE FROM grammars WHERE name LIKE $1', [`${PREFIX}%`]);
  // Closing must be the LAST thing this file does: db.js rebuilds the pool
  // lazily on the next query, so a cleanup statement after close() would
  // reopen it and leave Jest hanging on the handle.
  await db.close();
});

/* ========================================================================= */
/* 2. Scope equivalence — the listing agrees with the policy, row for row    */
/* ========================================================================= */

describe('list scoping equals the per-row policy', () => {
  /** The owner descriptor of each fixture grammar, as canAccess wants it. */
  function ownerOf(name) {
    return {
      ownerId: users[name].id,
      ownerTeacherId: users[name].teacherId,
    };
  }

  test.each(['admin', 'teacherA', 'teacherB', 'studentA1', 'studentB1'])(
    'GET /api/grammars returns exactly what %s may read',
    async (actorName) => {
      const response = await clients[actorName].get('/api/grammars');
      expect(response.status).toBe(200);

      const returned = new Set(response.body.map((doc) => doc.id));

      for (const ownerName of ['teacherA', 'teacherB', 'studentA1', 'studentA2', 'studentB1']) {
        const permitted = canAccess(users[actorName], 'grammar:read', ownerOf(ownerName));
        expect({ owner: ownerName, listed: returned.has(grammars[ownerName]) }).toEqual({
          owner: ownerName,
          listed: permitted,
        });
      }
    }
  );

  test('GET /api/users returns exactly the users the actor may read', async () => {
    const adminList = await clients.admin.get('/api/users');
    expect(adminList.status).toBe(200);
    const adminSees = new Set(adminList.body.map((u) => u.username));
    // An admin lists everyone, so every fixture account is present.
    for (const name of Object.keys(users)) {
      expect(adminSees.has(users[name].username)).toBe(true);
    }

    const teacherList = await clients.teacherA.get('/api/users');
    expect(teacherList.status).toBe(200);
    const teacherSees = teacherList.body.map((u) => u.username).sort();
    expect(teacherSees).toEqual([`${PREFIX}-student-a1`, `${PREFIX}-student-a2`]);

    // Every row a teacher is shown is one canAccess would admit individually.
    for (const row of teacherList.body) {
      expect(canAccess(users.teacherA, 'user:read', row)).toBe(true);
    }
  });
});

/* ========================================================================= */
/* 3. Wiring — the rules hold over HTTP                                      */
/* ========================================================================= */

describe('unauthenticated requests are refused', () => {
  test.each([
    ['get', '/api/grammars'],
    ['post', '/api/grammars'],
    ['get', '/api/users'],
    ['post', '/api/users'],
    ['get', '/api/auth/me'],
  ])('%s %s answers 401', async (method, path) => {
    const response = await request(app)[method](path).send({});
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('the algorithm endpoints stay open', async () => {
    const validate = await request(app).post('/api/validate').send({ grammar: anbn() });
    expect(validate.status).toBe(200);

    const examples = await request(app).get('/api/examples');
    expect(examples.status).toBe(200);
  });
});

describe('students are kept out of user management', () => {
  test.each([
    ['get', '/api/users'],
    ['post', '/api/users'],
  ])('%s %s answers 403 for a student', async (method, path) => {
    const response = await clients.studentA1[method](path).send({
      username: `${PREFIX}-sneaky`,
      password: PASSWORD,
      role: 'teacher',
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('a student cannot delete anyone', async () => {
    const response = await clients.studentA1.delete(`/api/users/${users.studentA2.id}`);
    expect(response.status).toBe(403);
  });
});

describe('teachers act only within their own class', () => {
  test('a teacher cannot create another teacher', async () => {
    const response = await clients.teacherA
      .post('/api/users')
      .send({ username: `${PREFIX}-nope`, password: PASSWORD, role: 'teacher' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test("a teacher's new student is assigned to them, whatever the body claims", async () => {
    const created = await clients.teacherA.post('/api/users').send({
      username: `${PREFIX}-student-a3`,
      password: PASSWORD,
      role: 'student',
      teacherId: users.teacherB.id, // ignored
    });
    expect(created.status).toBe(201);
    expect(created.body.teacherId).toBe(users.teacherA.id);
  });

  test("another teacher's student is invisible, not merely forbidden", async () => {
    const response = await clients.teacherA.delete(`/api/users/${users.studentB1.id}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
  });

  test('a teacher may reset their own student\'s password but not another\'s', async () => {
    const own = await clients.teacherA
      .post(`/api/users/${users.studentA2.id}/password`)
      .send({ newPassword: 'a-brand-new-password' });
    expect(own.status).toBe(204);

    const foreign = await clients.teacherA
      .post(`/api/users/${users.studentB1.id}/password`)
      .send({ newPassword: 'a-brand-new-password' });
    expect(foreign.status).toBe(404);
  });

  test('an admin creating a student must name an existing teacher', async () => {
    const orphan = await clients.admin
      .post('/api/users')
      .send({ username: `${PREFIX}-orphan`, password: PASSWORD, role: 'student' });
    expect(orphan.status).toBe(400);
    expect(orphan.body.error.code).toBe('TEACHER_REQUIRED');

    const notATeacher = await clients.admin.post('/api/users').send({
      username: `${PREFIX}-orphan`,
      password: PASSWORD,
      role: 'student',
      teacherId: users.studentA1.id, // a student cannot own students
    });
    expect(notATeacher.status).toBe(400);
    expect(notATeacher.body.error.code).toBe('TEACHER_REQUIRED');
  });

  test('nobody can create an administrator through the API', async () => {
    const response = await clients.admin
      .post('/api/users')
      .send({ username: `${PREFIX}-root`, password: PASSWORD, role: 'admin' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_ROLE');
  });

  test('an admin cannot delete their own account', async () => {
    const response = await clients.admin.delete(`/api/users/${users.admin.id}`);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

describe('grammar access over HTTP — 404 before 403', () => {
  test("a teacher can READ their own student's grammar", async () => {
    const response = await clients.teacherA.get(`/api/grammars/${grammars.studentA1}`);
    expect(response.status).toBe(200);
    expect(response.body.ownerId).toBe(users.studentA1.id);
  });

  test("a teacher canNOT modify or delete their own student's grammar — 403, not 404", async () => {
    const update = await clients.teacherA
      .put(`/api/grammars/${grammars.studentA1}`)
      .send({ grammar: { ...anbn(), name: 'hijacked' } });
    expect(update.status).toBe(403);
    expect(update.body.error.code).toBe('FORBIDDEN');

    const remove = await clients.teacherA.delete(`/api/grammars/${grammars.studentA1}`);
    expect(remove.status).toBe(403);

    // And the grammar really is untouched.
    const after = await clients.studentA1.get(`/api/grammars/${grammars.studentA1}`);
    expect(after.body.name).toBe(`${PREFIX} studentA1`);
  });

  test('a grammar outside the jurisdiction is reported as absent, not forbidden', async () => {
    const read = await clients.teacherA.get(`/api/grammars/${grammars.studentB1}`);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('GRAMMAR_NOT_FOUND');

    const write = await clients.teacherA
      .put(`/api/grammars/${grammars.studentB1}`)
      .send({ grammar: anbn() });
    expect(write.status).toBe(404);
  });

  test("a student cannot see a classmate's grammar at all", async () => {
    const response = await clients.studentA1.get(`/api/grammars/${grammars.studentA2}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('GRAMMAR_NOT_FOUND');
  });

  test("a student cannot see their own teacher's grammar", async () => {
    const response = await clients.studentA1.get(`/api/grammars/${grammars.teacherA}`);
    expect(response.status).toBe(404);
  });

  test('an admin reads and writes anything', async () => {
    const read = await clients.admin.get(`/api/grammars/${grammars.studentB1}`);
    expect(read.status).toBe(200);

    const write = await clients.admin
      .put(`/api/grammars/${grammars.studentB1}`)
      .send({ grammar: { ...anbn(), name: `${PREFIX} edited by admin` } });
    expect(write.status).toBe(200);
    // Ownership survives an edit by someone else.
    expect(write.body.ownerId).toBe(users.studentB1.id);
  });

  test('a saved grammar belongs to whoever saved it', async () => {
    const response = await clients.studentA1
      .post('/api/grammars')
      .send({ grammar: { ...anbn(), name: `${PREFIX} ownership` } });
    expect(response.status).toBe(201);
    expect(response.body.ownerId).toBe(users.studentA1.id);
  });
});
