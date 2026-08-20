# CFG Studio

An educational web application for the **design and computation of Context-Free Grammars (CFGs)** — create and validate grammars, convert them to Chomsky Normal Form step by step, test string membership with two independent parser engines (Earley and CYK, each animated step by step), run whole batches of strings as a regression test, and explore the resulting parse tree interactively.

Developed as a Bachelor's Thesis project:
*“Development of a Web Application for the Design and Computation of Context-Free Grammars (CFGs)”*.

CFG Studio follows the educational philosophy of classroom tools like **JFLAP**, but focuses **exclusively on context-free grammars** (no automata, no Turing machines, no regular expressions) and is built for the web with a deliberately minimal, academic interface.

---

## Features

- **Grammar editor** — define the 4-tuple G = (V, Σ, P, S) through friendly form controls: dynamic production rows with per-row ε insertion, precise inline parse feedback, symbol chips, a live textbook-style grammar overview, and draft autosave in the browser so work survives reloads.
- **Live validation** — errors (missing/undeclared start symbol, undefined symbols, invalid names, duplicates…) and warnings (unreachable variables, non-generating variables, unused terminals, empty language) with descriptive, student-oriented messages, re-checked on every keystroke.
- **CNF conversion** — the complete classic pipeline **START → TERM → BIN → DEL → UNIT → CLEANUP** in the order that provably avoids exponential blow-up. Every stage shows exactly which rules were added, removed or replaced *and why*, with the full intermediate grammar available at each step.
- **Two parser engines, your choice** — parse the grammar **directly** (Earley, no conversion needed) or **via Chomsky Normal Form** (CYK), chosen on the simulator screen and labelled by what each one does rather than by its name. A third option runs **both and compares** them: the verdict is always identical — they decide the same language — while the timings are not, which is what makes the comparison worth showing.
- **CYK simulator** — the Cocke–Younger–Kasami algorithm animated cell by cell: the current cell, the two source cells and the rules being used are highlighted while a live caption explains each step. Play / pause / step forward / step back / skip / speed controls. Verdict: **Accepted** or **Rejected**.
- **Earley chart animation** — the same playback controls driving the other engine's chart: one column per input position, filled with dotted items `A → α • β (j)`, with each PREDICT / SCAN / COMPLETE colour-coded and captioned. A completion highlights the item it reached back to, however many columns earlier that is — the one respect in which the chart is harder to follow than the table, where the two sources are always adjacent. Completions produced by the ε-repair say so, so the subtlest part of the algorithm is visible rather than buried. Above **12 characters** the parse still runs in full and only the replay is skipped.
- **Parse tree** — rendered as clean SVG: centred tidy layout, pan by dragging, zoom with the wheel or buttons, fit-to-view, and standalone **SVG export**, with the leftmost derivation listed alongside. Earley's tree is labelled with **the symbols you declared**; CYK's with the **converted** grammar's, where names like `X1` come from the conversion — the tree footer says which you are looking at, and after a compare run a toggle flips between the two.
- **Saved test strings** — a grammar carries its own `{accept, reject}` expectations, saved, exported and imported along with it (the same shape the built-in samples use). Only the expected outcome is stored, never which engine produced it.
- **Batch run** — run up to 50 strings, or every saved test string, in one press. Execution is **asynchronous**: one string at a time with a live progress bar and a working Cancel, rather than a loop that freezes the page. Results come back as a table of *string / result / expected / match* with a `7 / 8 passed` summary, and clicking any row opens that string in the simulator. Together with saved test strings this is **regression testing for a grammar**: change a rule, press one button, see immediately whether something that used to work has broken.
- **Sample grammars** — Balanced Parentheses, aⁿbⁿ, Arithmetic Expressions, Simple Expression Grammar, Palindromes, Equal numbers of a's and b's — each with suggested accept/reject test strings, loadable with one click.
- **Save / Load / Import / Export** — grammars persist server-side in PostgreSQL behind a REST API; any grammar can be exported to a JSON file and imported back.
- **Accounts and roles** — an admin/teacher/student hierarchy with server-side sessions. Each account is created by the role above it (there is no public sign-up), students' grammars are private to them, and a teacher can read — but never alter — the work of their own students. See [User accounts and roles](#user-accounts-and-roles).
- **Polished UX** — toast notifications, confirmation dialogs before destructive actions, loading indicators, tooltips, subtle animations, a Help section with conventions and theory summaries, and a fully responsive layout.

## Technologies

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, JavaScript ES6+ (native ES modules — **no frontend framework**), Bootstrap 5 (served locally, no CDN) |
| Backend | Node.js (≥ 18), Express.js |
| Persistence | PostgreSQL (≥ 13) via `pg`, the pure-JavaScript driver (see design decision below) |
| Testing | Jest (+ supertest for HTTP-level API tests) |
| Deployment | Render (single Node web service, `render.yaml` blueprint included) |

### The shared algorithm core

The heart of the project is `core/` — seven **pure, dependency-free ES modules** (`grammar.js`, `validator.js`, `cnf.js`, `cyk.js`, `parser.js`, `earley.js`, `earley-tree.js`) with no DOM and no Node APIs. The browser imports them natively (`<script type="module">`), the Express services import the very same files for the REST endpoints, Jest tests them directly, and `npm run bench` times them. Every algorithm therefore exists **exactly once** in the codebase, and one test suite covers both the client and the server behaviour.

### Storage design decision — from JSON files to PostgreSQL

This decision was made twice, and both halves belong in the record: the second only makes sense against the first, and the first was not wrong.

**The original decision (v1) — JSON files instead of SQLite.** Grammars are small, self-contained, document-shaped objects (a few KB of variables, terminals and productions) that are always read and written as a whole — there were no relational queries, joins, or concurrent-write workloads that would benefit from SQL. JSON-file storage kept the dependency tree 100 % pure JavaScript: `better-sqlite3` is a native addon, and while prebuilt binaries usually work, any Node-version mismatch on a reviewer's machine falls back to a node-gyp compilation (requiring Python and a C++ toolchain on Windows) — exactly the "zero-setup" failure mode this project must avoid. JSON files were also human-readable, which served the educational goal: a student could open `data/grammars/*.json` and see precisely how a grammar is represented, the storage format being identical to the app's export format. The storage layer (`models/grammarStore.js`, with atomic write-temp-then-rename semantics and strict id validation) was the only module that touched the filesystem, so swapping in a database later was expected to be a one-file change.

**The transition.**

> In the first version, with a single user and no relational needs, JSON files were the appropriate choice. The introduction of accounts and a user hierarchy created relationships requiring queries, so storage moved to PostgreSQL — a change confined to one file, as originally anticipated.

A second force pushed the same way: hosting platforms give a free web service an **ephemeral filesystem**, so every redeploy silently erased saved work.

**Why PostgreSQL specifically.** The constraint that ruled out SQLite still holds, and PostgreSQL satisfies it. The `pg` driver is **100 % JavaScript**, so the dependency tree still compiles nothing. (`pg-native` exists and is deliberately *not* used, for the same reason.) Password hashing follows the same rule: `node:crypto`'s `scrypt` rather than `bcrypt` or `argon2`, both of which are native.

Grammars remain document-shaped. `variables`, `terminals` and `productions` are stored as **JSONB**, because a grammar is always read and written whole and there is never a query like "find every grammar containing rule X" — normalising them into child tables would add joins and buy nothing. The relationships that *are* queried — user to grammars, teacher to students — are real columns with real foreign keys. The export format is unchanged, so a student can still inspect exactly how a grammar is represented by exporting one.

The claim that `models/grammarStore.js` was the only module touching persistence turned out to be true: moving from files to SQL replaced that one file and changed **no service, controller or route**.

**The cost, stated plainly.** The first version ran with `npm install && npm start` on any machine, with no prerequisites at all — clone it, install it, open a browser. **PostgreSQL removes that property.** A reviewer now needs a database provisioned and reachable before the server will start, and the *Database setup* section below exists because of it. This was a conscious trade, made in exchange for multi-user support: accounts, roles and teacher–student relationships are not reasonably expressible as files, and durable saves across redeploys were not achievable without leaving the filesystem. It is the one place the project gave up zero-setup, and it is worth being clear about what survives it — the dependency tree still compiles nothing, so there is still no toolchain, no node-gyp, no Python and no C++ compiler in the picture. The requirement that was added is a *service*, not a build.

---

## Installation

Requirements: **Node.js ≥ 18** (LTS recommended) and **PostgreSQL ≥ 13**. Every npm dependency is pure JavaScript — no build tools and no compilers.

```bash
git clone <repository-url> cfg-studio
cd cfg-studio
npm install
```

### Database setup

**Development** (`DATABASE_URL`) can point at any PostgreSQL ≥ 13 — a hosted instance or a local one. Nothing needs to be created beyond an empty database: the server builds its own tables on startup.

**Tests** (`TEST_DATABASE_URL`) must point at a **local** database, because the suite issues hundreds of queries and network latency would make runs slow and erratic. Create it once, as a superuser:

```sql
CREATE ROLE cfg_studio LOGIN PASSWORD 'cfg_studio';
CREATE DATABASE cfg_studio_test OWNER cfg_studio;
```

On Windows `psql` is usually not on `PATH` — use pgAdmin's Query Tool, or:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres
```

Or run PostgreSQL in Docker instead of installing it:

```bash
docker run --name cfg-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:18
```

Then copy `.env.example` to `.env` and fill in both URLs. No schema or migration step is needed.

## Running locally

```bash
npm run dev     # development server with auto-reload  →  http://localhost:3000
npm start       # production-style start
npm test        # run the full Jest suite (552 tests)
npm run test:coverage   # tests + coverage report
npm run bench   # time CYK against Earley on the six sample grammars
```

Only the first three need a database. `npm run bench` imports `core/` directly and reads `data/samples.json`, so it runs on a bare clone with nothing configured.

Configuration — copy `.env.example` to `.env` and adjust:

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string; the server refuses to start without it |
| `TEST_DATABASE_URL` | *(required for `npm test`)* | a **local** database whose name must end in `_test` |
| `ADMIN_USERNAME` | — | first administrator, created on startup if absent |
| `ADMIN_PASSWORD` | — | that administrator's password, hashed with scrypt before storage |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `production` hides stack traces and enables static caching |

TLS is taken from the connection string and never overridden in code: use `sslmode=verify-full` for a remote database and `sslmode=disable` for a local one. Prefer `verify-full` over `require` — they give identical verified TLS today, but `require` prints a deprecation warning and will mean *unverified* TLS in `pg` 9.

If `ADMIN_USERNAME` and `ADMIN_PASSWORD` are missing the server still starts and every algorithm, sample and page works; only saving a grammar fails, with `503 SERVER_NOT_CONFIGURED`. Both variables can be cleared once the account exists — the bootstrap never overwrites an existing account, so changing `ADMIN_PASSWORD` later does not reset a live password.

**The size limits are deliberately not environment variables.** They are constants, and each lives next to the thing it protects: `LIMITS` in `services/computeService.js` (100 variables, 100 terminals, 200 productions, 50 symbols per right-hand side, 50 saved test strings per grammar), `MAX_INPUT_LENGTH` in `core/cyk.js` and `core/earley.js` (30 characters, and `computeService` imports the constant rather than repeating the number), `ANIMATED_MAX_LENGTH` in `public/js/earley-chart.js` (12 characters), and `MAX_BATCH_STRINGS` in `public/js/views/batch-view.js` (50). They bound what the algorithms can be asked to do and what stays readable on screen, so an operator raising them by configuration would be changing a documented property of the tool, not tuning a deployment.

### How the tests isolate themselves

`npm test` runs against `TEST_DATABASE_URL`, never the development database, and always a **local** one: the suite issues hundreds of queries, so network latency and a suspended cloud database would make runs slow and erratic.

Isolation is pure configuration — no code in the application distinguishes test from production. Jest's `globalSetup` creates a dedicated schema (`cfg_studio_test`), selects it by appending `options=-c search_path=…` to the connection string, migrates it, and drops it again in `globalTeardown`. As a safeguard the harness refuses any database whose name does not end in `_test`.

Because the run shares one schema, `npm test` cannot be run twice concurrently on the same database.

## Project structure

```
├── server.js                # HTTP entry point (port binding, graceful shutdown)
├── app.js                   # Express app assembly (middleware, static mounts, routes, errors)
├── core/                    # ★ shared pure algorithm modules (browser + server + Jest)
│   ├── grammar.js           #   grammar model, tokenizer, parsing, (de)serialization
│   ├── validator.js         #   semantic validation + reachability/generating analyses
│   ├── cnf.js               #   six-stage CNF conversion with step trace
│   ├── cyk.js               #   CYK with backpointers + animation trace
│   ├── parser.js            #   parse-tree reconstruction, leftmost derivation
│   ├── earley.js            #   Earley chart parser — no CNF conversion needed
│   └── earley-tree.js       #   parse tree in the ORIGINAL grammar
├── routes/                  # API route tables
├── controllers/             # thin HTTP request/response handling
├── middleware/              # requireAuth (cookie → req.user), requireRole
├── services/                # business rules (validate-before-save, size guards)
│   ├── userService.js       #   ★ canAccess() — the single authorization decision
│   └── authService.js       #   login/logout, session tokens, password change
├── models/                  # the only layer that touches persistence
│   ├── db.js                #   PostgreSQL pool (lazy, TLS from the URL, retry-once)
│   ├── schema.sql           #   users / grammars / sessions, idempotent DDL
│   ├── migrate.js           #   applies the schema + bootstraps the first admin
│   ├── grammarStore.js      #   grammar CRUD, filtered by owner
│   ├── userStore.js         #   account CRUD
│   └── sessionStore.js      #   sessions keyed by sha256(token)
├── utils/                   # HttpError, asyncHandler, scrypt hashing, session cookie
├── data/samples.json        # built-in sample grammars + their test strings (read-only)
├── views/
│   ├── index.html           # the single-page UI (all sections, incl. Help)
│   └── 404.html
├── public/
│   ├── css/styles.css       # academic theme on top of Bootstrap
│   └── js/                  # app shell, SVG tree renderer, step player
│       ├── engines.js       #   which engine runs on which grammar, and its timing
│       ├── measure.js       #   ★ the timing method, shared with scripts/benchmark.js
│       ├── earley-chart.js  #   Earley chart renderer + trace replay
│       ├── tree.js          #   SVG tree layout, pan/zoom, export
│       ├── animations.js    #   StepPlayer — playback shared by both simulations
│       └── views/           #   one module per screen (editor, cnf, cyk, batch,
│                            #   tree, grammars, users, login)
├── scripts/benchmark.js     # `npm run bench` — the figures in docs/algorithms.md §9
├── docs/algorithms.md       # theory, pseudo-code, complexity for every algorithm
└── tests/                   # 10 Jest suites, shared fixtures
```

## User accounts and roles

```
admin  ──creates──▶  teacher  ──creates──▶  student
```

**There is no registration page.** An account only ever comes into existence from the role above it, which guarantees that no student exists without a teacher and that nobody can create an account on a public URL. The first administrator is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` on startup; everyone else is created through the **Users** screen.

| Action | admin | teacher | student |
|---|---|---|---|
| Create teacher | yes | no | no |
| Create student | yes | yes (own) | no |
| Delete user / reset password | yes | own students only | no |
| List users | all | own students only | no |
| Create grammar / use algorithms | yes | yes | yes |
| Read grammar | all | own + own students' | own |
| Update / delete grammar | all | own only | own |

Everyone can change their own password.

Two implementation notes that matter more than the table:

- **One authorization function.** With three roles the question is no longer "is this mine?" but "is this within my jurisdiction?" — a relation between two users. It is answered in exactly one place, `canAccess(actor, action, target)` in `services/userService.js`: pure, synchronous, and failing closed on an unknown action or role. `tests/authorization.test.js` walks the whole matrix. Scattering role checks across controllers would mean one forgotten check is a silent hole.
- **A target you cannot read is reported as absent, not forbidden.** 404 comes before 403, so probing the API cannot map out which grammar ids or usernames exist. A 403 is only ever returned for something the caller can already see — a teacher told "this is your student's, you may read it but not change it".

Sessions are rows in the `sessions` table, not self-contained tokens: logging out, deleting a user and resetting a password all take effect on the next request, because the row is gone. Only `sha256(token)` is stored — never the token itself — and a `CHECK` constraint on the column enforces it.

## REST API

Endpoints marked ● require a session cookie.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | sign in; sets an httpOnly session cookie |
| POST | `/api/auth/logout` | ● sign out (deletes the session row) |
| GET | `/api/auth/me` | ● the signed-in user |
| POST | `/api/auth/password` | ● change your own password |
| GET | `/api/users` | ● list users within your jurisdiction |
| POST | `/api/users` | ● create a teacher or student |
| DELETE | `/api/users/:id` | ● delete a user |
| POST | `/api/users/:id/password` | ● reset someone's password |
| GET | `/api/grammars` | ● list saved grammars (metadata) |
| POST | `/api/grammars` | ● save a grammar (validated server-side) |
| GET | `/api/grammars/:id` | ● fetch one grammar |
| PUT | `/api/grammars/:id` | ● update a grammar |
| DELETE | `/api/grammars/:id` | ● delete a grammar |
| GET | `/api/examples` | built-in sample grammars |
| POST | `/api/validate` | validate a grammar payload |
| POST | `/api/cnf` | CNF conversion with the full step trace |
| POST | `/api/cyk` | run CYK: `{ grammar, input }` → table + trace + verdict |
| GET | `/healthz` | health check |

The three algorithm endpoints (`/api/validate`, `/api/cnf`, `/api/cyk`) and `/api/examples` are deliberately open: they are stateless, already bounded by the size limits in `services/computeService.js`, hold no user data, and exist to be usable from a script. A session there would protect nothing.

Errors always have the shape `{ "error": { "code", "message", "details?" } }` with stable machine-readable codes.

## Algorithms

Full documentation — *theory, pseudo-code, complexity and implementation notes* for every algorithm — lives in [`docs/algorithms.md`](docs/algorithms.md). In brief:

1. **Longest-match tokenization** of production right-hand sides (maximal munch against the declared symbol set) — O(n·k).
2. **Validation** — direct structural checks plus the two classic fixpoint analyses (generating variables bottom-up, reachable variables top-down) used diagnostically — O(|V|·|P|·L).
3. **CNF conversion** — START → TERM → BIN → DEL (nullable-set fixpoint + subset expansion) → UNIT (unit-pair closure) → CLEANUP, polynomial overall *because* BIN runs before DEL.
4. **CYK** — the O(n³·|P|) dynamic program over CNF; every table entry keeps all its derivations (backpointers), and a granular step trace drives the UI animation.
5. **Parse-tree reconstruction** — an O(n) top-down walk along the backpointers; the leftmost derivation is its pre-order traversal.
6. **Earley recognition** — the O(n³) chart parser that needs no normal form at all: predict / scan / complete over n+1 columns, with the Aycock–Horspool repair for nullable symbols and all derivations kept as backpointers.
7. **Earley parse-tree reconstruction** — the same walk over the chart's backpointers, producing an n-ary tree in the **original** grammar; the node shape is deliberately identical to the CYK one, so the renderer and every tree helper accept both unchanged.
8. **Tree layout** — simplified Reingold–Tilford (leaf slots + centre-over-children), rendered as hand-rolled SVG with viewBox-based pan/zoom.
9. **CYK versus Earley** — the theoretical comparison (CNF requirement, complexity, tree vocabulary and arity) together with its *empirical* confirmation: both engines measured on the six sample grammars and across input lengths up to the 30-character cap, produced by `npm run bench`.

## Testing

```bash
npm test
```

Ten suites, **552 tests**, covering the grammar model and its saved test strings, the validator (asserted by stable error codes), every CNF stage plus the full pipeline, CYK, the Earley parser, parse trees, the shipped sample grammars, authentication, authorization and the HTTP API (supertest against a throw-away PostgreSQL schema). Five test strategies deserve mention:

- **Language preservation:** a brute-force derivation enumerator (`tests/helpers.js`) proves L(G) = L(CNF(G)) for all strings up to a length bound on several grammars.
- **Exhaustive agreement:** CYK's verdict is compared against the enumerated language for *every* string over {a, b} up to length 5.
- **The permission matrix, exhaustively:** every (role, action, target) triple is asserted against `canAccess` as a plain table. A test that only exercises the endpoints someone remembered to write proves nothing about the combination they forgot.
- **The shipped samples, run for real:** every sample grammar in `data/samples.json` has its declared accept/reject strings actually run — through *both* engines, which must agree. The cross-checks elsewhere use hand-written fixtures, so nothing previously connected them to the file the application serves; a string filed under the wrong heading would have shipped in silence.
- **Scope equivalence:** the list queries are pinned to that policy empirically — rows owned by every fixture user are inserted, the real SQL runs, and the result must equal the set `canAccess` admits one row at a time. A `WHERE` clause that drifts wider than the policy fails.

`npm run bench` is **not** part of the suite and never will be. It measures how long the engines take, and a timing is not something a test run should be allowed to fail on — a busy machine would turn a green build red without a line of code having changed. It is a reporting utility for [`docs/algorithms.md` §9](docs/algorithms.md#9-cyk-versus-earley). The one property it does assert is that the two engines agree on every string it runs, because a benchmark comparing a working engine against a broken one would report meaningless numbers; the *correctness* version of that same cross-check lives in the suite, in `tests/samples.test.js`.

## Screenshots

> *(placeholders — to be captured from the deployed instance. Local captures are deliberately not used: they would show `localhost` and misrepresent the deployed application.)*

| View | Screenshot |
|---|---|
| Sign-in screen | `docs/screenshots/login.png` |
| Grammar editor with live validation | `docs/screenshots/editor.png` |
| CNF conversion steps | `docs/screenshots/cnf.png` |
| Animated Earley chart | `docs/screenshots/earley.png` |
| Animated CYK table | `docs/screenshots/cyk.png` |
| Interactive parse tree | `docs/screenshots/tree.png` |
| Batch run with results table | `docs/screenshots/batch.png` |
| Users screen (role hierarchy) | `docs/screenshots/users.png` |

## Deployment (Render)

The repository ships with a [`render.yaml`](render.yaml) blueprint: one Node web service that serves both the API and the static frontend from the same Express process — no separate frontend host is needed, because the frontend is static files and native ES modules with no build step. Persistence is a managed PostgreSQL instance reached over the network, so the web service itself holds no state and its filesystem may be as ephemeral as the platform likes.

**Step-by-step:**

1. Push the repository to GitHub (or GitLab/Bitbucket):
   ```bash
   git remote add origin https://github.com/<your-username>/cfg-studio.git
   git push -u origin master
   ```
2. Create a free account at [render.com](https://render.com) and connect your GitHub account.
3. In the Render dashboard choose **New → Blueprint** and select the repository — Render reads `render.yaml` and pre-fills everything. *(Alternatively: New → Web Service, pick the repo, set Build Command `npm ci` and Start Command `npm start`.)*
4. Click **Apply / Create Web Service**. The first build takes a minute; the health check (`/healthz`) turns the service live.
5. Open the public URL Render assigns (`https://cfg-studio-<hash>.onrender.com`) — the application is fully usable immediately, including all sample grammars.

**Notes:**

- Provision a **managed PostgreSQL** instance and set `DATABASE_URL` (with `sslmode=verify-full`), plus `ADMIN_USERNAME` and `ADMIN_PASSWORD`. All three are declared `sync: false` in the blueprint, so Render prompts for them and no credential is committed.
- Saved grammars now survive redeploys: the filesystem is still ephemeral, but nothing user-facing is stored on it. On the **free tier** the service sleeps after inactivity, so the first request takes ~30 s; a database that scales to zero is handled by a single automatic retry.
- The schema is created automatically on the first boot, before the server accepts traffic. If the migration fails the process exits non-zero and the previous deploy keeps serving.
- `NODE_ENV=production` is set by the blueprint: stack traces are hidden and static assets are cached.

## Future improvements

- ~~Map the CNF parse tree back onto the **original grammar's** productions.~~ **Answered from the other end** — rather than mapping a converted tree back, the Earley engine never converts at all, so its tree is already in the grammar as written (`core/earley-tree.js`). Mapping CYK's own tree back would still be a distinct piece of work, but the need it existed to serve is met.
- Show **all** parse trees of an ambiguous string (the backpointers of *both* engines already store every derivation).
- Additional transformations: left-recursion elimination, left factoring, Greibach Normal Form.
- Brute-force derivation explorer for short strings on non-CNF grammars.
- ~~Swap the storage layer for SQLite/PostgreSQL (one-file change) to enable durable multi-user persistence on serverless platforms.~~ **Done** — and it was indeed a one-file change: `models/grammarStore.js` was rewritten on SQL without touching a single service, controller or route.
- ~~User accounts~~ **done** (admin/teacher/student, see above) — shareable grammar links are still open.
- Internationalisation (Greek UI translation).

## License

MIT — see `package.json`. Built as a Bachelor's Thesis; free to use for teaching and learning.
