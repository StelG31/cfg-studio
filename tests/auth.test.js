/**
 * tests/auth.test.js
 * ---------------------------------------------------------------------------
 * Signing in, sessions and password handling.
 *
 * The claims worth testing here are the ones that would fail silently: a
 * session table holding raw tokens still logs people in, and a logout that
 * only clears the cookie still looks like it worked. So several tests below
 * reach past the API and read the database directly — the point is not that
 * the endpoint answered, but what it left behind.
 */

import crypto from 'node:crypto';
import request from 'supertest';

import { TEST_ADMIN } from './setup/testDb.js';
import { hashPassword, verifyPassword, needsRehash } from '../utils/password.js';
import { SESSION_COOKIE } from '../utils/sessionCookie.js';

let app;
let db;

/** Everything this file creates is prefixed, so cleanup can be precise. */
const PREFIX = 'authtest';
const PASSWORD = 'fixture-password';

beforeAll(async () => {
  ({ default: app } = await import('../app.js'));
  db = await import('../models/db.js');
});

afterAll(async () => {
  await db.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}-%`]);
  await db.close();
});

/** Pull the session cookie's value out of a Set-Cookie header. */
function sessionCookieFrom(response) {
  const header = response.headers['set-cookie'] ?? [];
  const cookie = header.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  return cookie ?? null;
}

function tokenFrom(response) {
  const cookie = sessionCookieFrom(response);
  return cookie === null ? null : decodeURIComponent(cookie.split(';')[0].split('=')[1]);
}

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/* ------------------------------------------------------------------------ */
/* Password hashing                                                          */
/* ------------------------------------------------------------------------ */

describe('password hashing', () => {
  test('a hash round-trips and rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
  });

  test('the same password hashes differently every time (per-user salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  test('a corrupt stored hash denies access instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(needsRehash('not-a-hash')).toBe(true);
  });

  test('a current hash does not ask to be rehashed', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Signing in                                                                */
/* ------------------------------------------------------------------------ */

describe('POST /api/auth/login', () => {
  test('a correct password returns the user and sets an httpOnly cookie', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });

    expect(response.status).toBe(200);
    expect(response.body.username).toBe(TEST_ADMIN.username);
    expect(response.body.role).toBe('admin');
    // A password hash must never be part of a user object leaving the server.
    expect(response.body.passwordHash).toBeUndefined();

    const cookie = sessionCookieFrom(response);
    expect(cookie).not.toBeNull();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // The raw token is a bearer credential and must not also travel in the body.
    expect(JSON.stringify(response.body)).not.toContain(tokenFrom(response));
  });

  test('the database stores sha256(token), never the token itself', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });

    const token = tokenFrom(response);
    expect(token).toBeTruthy();

    const stored = await db.query('SELECT id FROM sessions WHERE id = $1', [sha256(token)]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].id).toMatch(/^[a-f0-9]{64}$/);

    // The raw token appears nowhere in the table.
    const raw = await db.query('SELECT 1 FROM sessions WHERE id = $1', [token]);
    expect(raw.rowCount).toBe(0);
  });

  test('the username is matched case-insensitively', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username.toUpperCase(), password: TEST_ADMIN.password });
    expect(response.status).toBe(200);
    expect(response.body.username).toBe(TEST_ADMIN.username);
  });

  test('a wrong password and an unknown user are indistinguishable', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: 'not-the-password' });
    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ username: `${PREFIX}-nobody`, password: 'not-the-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    // Same code AND same message: neither reveals which half was wrong.
    expect(unknownUser.body.error).toEqual(wrongPassword.body.error);
    expect(sessionCookieFrom(wrongPassword)).toBeNull();
  });

  test.each([
    ['a missing body', {}],
    ['an empty password', { username: TEST_ADMIN.username, password: '' }],
    ['a non-string username', { username: { $ne: null }, password: 'x' }],
  ])('%s is refused as invalid credentials', async (_label, body) => {
    const response = await request(app).post('/api/auth/login').send(body);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

/* ------------------------------------------------------------------------ */
/* Using and ending a session                                                */
/* ------------------------------------------------------------------------ */

describe('sessions', () => {
  test('GET /api/auth/me answers 401 without a cookie and 200 with one', async () => {
    const anonymous = await request(app).get('/api/auth/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    const agent = request.agent(app);
    await agent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });

    const identified = await agent.get('/api/auth/me');
    expect(identified.status).toBe(200);
    expect(identified.body.username).toBe(TEST_ADMIN.username);
  });

  test('logout deletes the row, so the cookie stops working', async () => {
    const agent = request.agent(app);
    const signIn = await agent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });
    const id = sha256(tokenFrom(signIn));

    expect((await db.query('SELECT 1 FROM sessions WHERE id = $1', [id])).rowCount).toBe(1);

    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(204);
    expect((await db.query('SELECT 1 FROM sessions WHERE id = $1', [id])).rowCount).toBe(0);

    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  test.each([
    ['a garbage value', 'not-a-real-token'],
    ['a hex digest (someone pasting from the table)', 'a'.repeat(64)],
    ['an empty value', ''],
    ['a percent-escape that does not decode', '%E0%A4%A'],
  ])('a tampered cookie (%s) is refused without crashing', async (_label, value) => {
    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=${value}`);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('an expired session is refused', async () => {
    const signIn = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });
    const token = tokenFrom(signIn);

    // Backdate it rather than waiting seven days.
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [
      sha256(token),
    ]);

    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(response.status).toBe(401);
  });

  test('logging in sweeps expired rows away', async () => {
    const orphan = sha256('an-expired-session');
    const owner = await db.query('SELECT id FROM users WHERE username = $1', [TEST_ADMIN.username]);
    await db.query(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() - interval '1 day')",
      [orphan, owner.rows[0].id]
    );

    await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });

    expect((await db.query('SELECT 1 FROM sessions WHERE id = $1', [orphan])).rowCount).toBe(0);
  });

  test('deleting a user kills their live session immediately', async () => {
    const admin = request.agent(app);
    await admin
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });

    const created = await admin
      .post('/api/users')
      .send({ username: `${PREFIX}-doomed`, password: PASSWORD, role: 'teacher' });
    expect(created.status).toBe(201);

    const victim = request.agent(app);
    await victim.post('/api/auth/login').send({ username: `${PREFIX}-doomed`, password: PASSWORD });
    expect((await victim.get('/api/auth/me')).status).toBe(200);

    expect((await admin.delete(`/api/users/${created.body.id}`)).status).toBe(204);

    // No logout, no expiry — the session row went with the user (ON DELETE
    // CASCADE), which a self-contained token could not have achieved.
    expect((await victim.get('/api/auth/me')).status).toBe(401);
  });
});

/* ------------------------------------------------------------------------ */
/* Changing and resetting passwords                                          */
/* ------------------------------------------------------------------------ */

describe('POST /api/auth/password (self-service)', () => {
  const username = `${PREFIX}-changer`;
  let agent;

  beforeAll(async () => {
    const admin = request.agent(app);
    await admin
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });
    const created = await admin
      .post('/api/users')
      .send({ username, password: PASSWORD, role: 'teacher' });
    expect(created.status).toBe(201);

    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username, password: PASSWORD });
  }, 30_000);

  test('the current password must be correct', async () => {
    const response = await agent
      .post('/api/auth/password')
      .send({ currentPassword: 'wrong', newPassword: 'a-perfectly-fine-password' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('the new password must satisfy the policy', async () => {
    const response = await agent
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('WEAK_PASSWORD');
  });

  test('a successful change swaps the password, keeps this session and drops the others', async () => {
    // A second device, signed in with the old password.
    const elsewhere = request.agent(app);
    await elsewhere.post('/api/auth/login').send({ username, password: PASSWORD });
    expect((await elsewhere.get('/api/auth/me')).status).toBe(200);

    const changed = await agent
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    expect(changed.status).toBe(204);

    // This browser was handed a replacement session and stays signed in...
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    // ...while the other one is out.
    expect((await elsewhere.get('/api/auth/me')).status).toBe(401);

    const oldPassword = await request(app)
      .post('/api/auth/login')
      .send({ username, password: PASSWORD });
    expect(oldPassword.status).toBe(401);

    const newPassword = await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'a-brand-new-password' });
    expect(newPassword.status).toBe(200);
  }, 30_000);
});

describe('POST /api/users/:id/password (reset by someone above)', () => {
  test('a reset changes the password and ejects the holder of the old one', async () => {
    const admin = request.agent(app);
    await admin
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });

    const created = await admin
      .post('/api/users')
      .send({ username: `${PREFIX}-forgetful`, password: PASSWORD, role: 'teacher' });
    expect(created.status).toBe(201);

    const victim = request.agent(app);
    await victim
      .post('/api/auth/login')
      .send({ username: `${PREFIX}-forgetful`, password: PASSWORD });
    expect((await victim.get('/api/auth/me')).status).toBe(200);

    const reset = await admin
      .post(`/api/users/${created.body.id}/password`)
      .send({ newPassword: 'issued-by-the-admin' });
    expect(reset.status).toBe(204);

    // Whoever held the old password loses the access it bought them.
    expect((await victim.get('/api/auth/me')).status).toBe(401);

    const old = await request(app)
      .post('/api/auth/login')
      .send({ username: `${PREFIX}-forgetful`, password: PASSWORD });
    expect(old.status).toBe(401);

    const fresh = await request(app)
      .post('/api/auth/login')
      .send({ username: `${PREFIX}-forgetful`, password: 'issued-by-the-admin' });
    expect(fresh.status).toBe(200);
  }, 30_000);
});

/* ------------------------------------------------------------------------ */
/* Account creation rules                                                    */
/* ------------------------------------------------------------------------ */

describe('account creation', () => {
  let admin;

  beforeAll(async () => {
    admin = request.agent(app);
    await admin
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });
  });

  test('usernames are stored lower case and must be unique regardless of case', async () => {
    const created = await admin
      .post('/api/users')
      .send({ username: `${PREFIX}-MiXeD`, password: PASSWORD, role: 'teacher' });
    expect(created.status).toBe(201);
    expect(created.body.username).toBe(`${PREFIX}-mixed`);

    const duplicate = await admin
      .post('/api/users')
      .send({ username: `${PREFIX}-MIXED`, password: PASSWORD, role: 'teacher' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('USERNAME_TAKEN');
  });

  test.each([
    ['too short', 'ab'],
    ['illegal characters', 'has spaces'],
    ['too long', 'x'.repeat(33)],
  ])('a username that is %s is refused', async (_label, username) => {
    const response = await admin
      .post('/api/users')
      .send({ username, password: PASSWORD, role: 'teacher' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_USERNAME');
  });

  test.each([
    ['too short', 'short'],
    ['absurdly long', 'x'.repeat(201)],
    ['not a string', 12345678],
  ])('a password that is %s is refused', async (_label, password) => {
    const response = await admin
      .post('/api/users')
      .send({ username: `${PREFIX}-pw`, password, role: 'teacher' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('WEAK_PASSWORD');
  });

  test('there is no registration endpoint', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ username: `${PREFIX}-intruder`, password: PASSWORD });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
