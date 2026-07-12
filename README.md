# CFG Studio

An educational web application for the **design and computation of Context-Free Grammars (CFGs)** — create and validate grammars, convert them to Chomsky Normal Form step by step, test string membership with an animated CYK simulation, and explore the resulting parse tree interactively.

Developed as a Bachelor's Thesis project:
*“Development of a Web Application for the Design and Computation of Context-Free Grammars (CFGs)”*.

CFG Studio follows the educational philosophy of classroom tools like **JFLAP**, but focuses **exclusively on context-free grammars** (no automata, no Turing machines, no regular expressions) and is built for the web with a deliberately minimal, academic interface.

---

## Features

- **Grammar editor** — define the 4-tuple G = (V, Σ, P, S) through friendly form controls: dynamic production rows with per-row ε insertion, precise inline parse feedback, symbol chips, a live textbook-style grammar overview, and draft autosave in the browser so work survives reloads.
- **Live validation** — errors (missing/undeclared start symbol, undefined symbols, invalid names, duplicates…) and warnings (unreachable variables, non-generating variables, unused terminals, empty language) with descriptive, student-oriented messages, re-checked on every keystroke.
- **CNF conversion** — the complete classic pipeline **START → TERM → BIN → DEL → UNIT → CLEANUP** in the order that provably avoids exponential blow-up. Every stage shows exactly which rules were added, removed or replaced *and why*, with the full intermediate grammar available at each step.
- **CYK simulator** — the Cocke–Younger–Kasami algorithm animated cell by cell: the current cell, the two source cells and the rules being used are highlighted while a live caption explains each step. Play / pause / step forward / step back / skip / speed controls. Verdict: **Accepted** or **Rejected**.
- **Parse tree** — reconstructed from the CYK table's backpointers and rendered as clean SVG: centred tidy layout, pan by dragging, zoom with the wheel or buttons, fit-to-view, and standalone **SVG export**. The leftmost derivation encoded by the tree is listed alongside.
- **Sample grammars** — Balanced Parentheses, aⁿbⁿ, Arithmetic Expressions, Simple Expression Grammar, Palindromes, Equal numbers of a's and b's — each with suggested accept/reject test strings, loadable with one click.
- **Save / Load / Import / Export** — grammars persist server-side (JSON file storage behind a REST API); any grammar can be exported to a JSON file and imported back.
- **Polished UX** — toast notifications, confirmation dialogs before destructive actions, loading indicators, tooltips, subtle animations, a Help section with conventions and theory summaries, and a fully responsive layout.

## Technologies

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, JavaScript ES6+ (native ES modules — **no frontend framework**), Bootstrap 5 (served locally, no CDN) |
| Backend | Node.js (≥ 18), Express.js |
| Persistence | JSON files on disk via a dedicated storage layer (see design decision below) |
| Testing | Jest (+ supertest for HTTP-level API tests) |
| Deployment | Render (single Node web service, `render.yaml` blueprint included) |

### The shared algorithm core

The heart of the project is `core/` — five **pure, dependency-free ES modules** (`grammar.js`, `validator.js`, `cnf.js`, `cyk.js`, `parser.js`) with no DOM and no Node APIs. The browser imports them natively (`<script type="module">`), the Express services import the very same files for the REST endpoints, and Jest tests them directly. Every algorithm therefore exists **exactly once** in the codebase, and one test suite covers both the client and the server behaviour.

### Storage design decision — JSON files instead of SQLite

Grammars are small, self-contained, document-shaped objects (a few KB of variables, terminals and productions) that are always read and written as a whole — there are no relational queries, joins, or concurrent-write workloads that would benefit from SQL. JSON-file storage keeps the dependency tree 100 % pure JavaScript: `better-sqlite3` is a native addon, and while prebuilt binaries usually work, any Node-version mismatch on a reviewer's machine falls back to a node-gyp compilation (requiring Python and a C++ toolchain on Windows) — exactly the "zero-setup" failure mode this project must avoid. JSON files are also human-readable, which serves the educational goal: a student can open `data/grammars/*.json` and see precisely how a grammar is represented — the storage format is identical to the app's export format. The storage layer (`models/grammarStore.js`, with atomic write-temp-then-rename semantics and strict id validation) is the only module that touches the filesystem, so swapping in SQLite later is a one-file change — listed under *Future improvements*.

---

## Installation

Requirements: **Node.js ≥ 18** (LTS recommended). Everything else is pure JavaScript — no build tools, no compilers, no database server.

```bash
git clone <repository-url> cfg-studio
cd cfg-studio
npm install
```

## Running locally

```bash
npm run dev     # development server with auto-reload  →  http://localhost:3000
npm start       # production-style start
npm test        # run the full Jest suite (159 tests)
npm run test:coverage   # tests + coverage report
```

Optional configuration — copy `.env.example` to `.env` and adjust:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `production` hides stack traces and enables static caching |
| `DATA_DIR` | `./data/grammars` | where saved grammars are written |

The application runs with sensible defaults if no `.env` exists.

## Project structure

```
├── server.js                # HTTP entry point (port binding, graceful shutdown)
├── app.js                   # Express app assembly (middleware, static mounts, routes, errors)
├── core/                    # ★ shared pure algorithm modules (browser + server + Jest)
│   ├── grammar.js           #   grammar model, tokenizer, parsing, (de)serialization
│   ├── validator.js         #   semantic validation + reachability/generating analyses
│   ├── cnf.js               #   six-stage CNF conversion with step trace
│   ├── cyk.js               #   CYK with backpointers + animation trace
│   └── parser.js            #   parse-tree reconstruction, leftmost derivation
├── routes/                  # API route tables
├── controllers/             # thin HTTP request/response handling
├── services/                # business rules (validate-before-save, size guards)
├── models/grammarStore.js   # JSON-file persistence (atomic writes)
├── utils/                   # HttpError, asyncHandler
├── data/samples.json        # built-in sample grammars (data/grammars/ holds user saves)
├── views/index.html         # the single-page UI (+ 404 page)
├── public/
│   ├── css/styles.css       # academic theme on top of Bootstrap
│   └── js/                  # app shell, view modules, SVG tree renderer, step player
├── docs/algorithms.md       # theory, pseudo-code, complexity for every algorithm
└── tests/                   # 6 Jest suites, 159 tests, shared fixtures
```

## REST API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/grammars` | list saved grammars (metadata) |
| POST | `/api/grammars` | save a grammar (validated server-side) |
| GET | `/api/grammars/:id` | fetch one grammar |
| PUT | `/api/grammars/:id` | update a grammar |
| DELETE | `/api/grammars/:id` | delete a grammar |
| GET | `/api/examples` | built-in sample grammars |
| POST | `/api/validate` | validate a grammar payload |
| POST | `/api/cnf` | CNF conversion with the full step trace |
| POST | `/api/cyk` | run CYK: `{ grammar, input }` → table + trace + verdict |
| GET | `/healthz` | health check |

Errors always have the shape `{ "error": { "code", "message", "details?" } }` with stable machine-readable codes.

## Algorithms

Full documentation — *theory, pseudo-code, complexity and implementation notes* for every algorithm — lives in [`docs/algorithms.md`](docs/algorithms.md). In brief:

1. **Longest-match tokenization** of production right-hand sides (maximal munch against the declared symbol set) — O(n·k).
2. **Validation** — direct structural checks plus the two classic fixpoint analyses (generating variables bottom-up, reachable variables top-down) used diagnostically — O(|V|·|P|·L).
3. **CNF conversion** — START → TERM → BIN → DEL (nullable-set fixpoint + subset expansion) → UNIT (unit-pair closure) → CLEANUP, polynomial overall *because* BIN runs before DEL.
4. **CYK** — the O(n³·|P|) dynamic program over CNF; every table entry keeps all its derivations (backpointers), and a granular step trace drives the UI animation.
5. **Parse-tree reconstruction** — an O(n) top-down walk along the backpointers; the leftmost derivation is its pre-order traversal.
6. **Tree layout** — simplified Reingold–Tilford (leaf slots + centre-over-children), rendered as hand-rolled SVG with viewBox-based pan/zoom.

## Testing

```bash
npm test
```

Six suites, **159 tests**, covering the grammar model, the validator (asserted by stable error codes), every CNF stage plus the full pipeline, CYK, parse trees and the HTTP API (supertest against a temporary data directory). Two test strategies deserve mention:

- **Language preservation:** a brute-force derivation enumerator (`tests/helpers.js`) proves L(G) = L(CNF(G)) for all strings up to a length bound on several grammars.
- **Exhaustive agreement:** CYK's verdict is compared against the enumerated language for *every* string over {a, b} up to length 5.

## Screenshots

> *(placeholders — capture after deployment)*

| View | Screenshot |
|---|---|
| Grammar editor with live validation | `docs/screenshots/editor.png` |
| CNF conversion steps | `docs/screenshots/cnf.png` |
| Animated CYK table | `docs/screenshots/cyk.png` |
| Interactive parse tree | `docs/screenshots/tree.png` |

## Deployment (Render)

The repository ships with a [`render.yaml`](render.yaml) blueprint: one Node web service that serves both the API and the static frontend (the same Express process — no separate frontend host is needed, and the file-based storage requires a persistent process with a filesystem, which rules out serverless platforms for this architecture).

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

- On the **free tier** the filesystem is *ephemeral*: user-saved grammars survive restarts but are reset on every redeploy, and the service sleeps after inactivity (the first request then takes ~30 s). The built-in samples and every algorithm work regardless.
- For durable saves, attach a **Render Disk** (paid) and point `DATA_DIR` to its mount path — no code changes required.
- `NODE_ENV=production` is set by the blueprint: stack traces are hidden and static assets are cached.

## Future improvements

- Map the CNF parse tree back onto the **original grammar's** productions.
- Show **all** parse trees of an ambiguous string (the backpointers already store every derivation).
- Additional transformations: left-recursion elimination, left factoring, Greibach Normal Form.
- Brute-force derivation explorer for short strings on non-CNF grammars.
- Swap the storage layer for SQLite/PostgreSQL (one-file change) to enable durable multi-user persistence on serverless platforms.
- User accounts and shareable grammar links.
- Internationalisation (Greek UI translation).

## License

MIT — see `package.json`. Built as a Bachelor's Thesis; free to use for teaching and learning.
