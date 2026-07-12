# CFG Studio

An educational web application for the **design and computation of Context-Free Grammars (CFGs)** — create and validate grammars, convert them to Chomsky Normal Form step by step, test string membership with an animated CYK simulation, and explore the resulting parse tree.

Developed as a Bachelor's Thesis project:
*“Development of a Web Application for the Design and Computation of Context-Free Grammars (CFGs)”*.

> **Status:** under active development. This README grows together with the application; the full feature, algorithm and deployment documentation is completed in the final documentation step.

## Technologies

- **Frontend:** HTML5, CSS3, JavaScript (ES6+ native modules — no frontend framework), Bootstrap 5
- **Backend:** Node.js, Express.js
- **Persistence:** JSON files on disk (see *Storage design decision* below)
- **Testing:** Jest (+ supertest for the HTTP API)

## Storage design decision — JSON files instead of SQLite

Grammars are small, self-contained, document-shaped objects (a few KB of variables, terminals and productions) that are always read and written as a whole — there are no relational queries, joins, or concurrent-write workloads that would benefit from SQL. JSON-file storage keeps the dependency tree 100 % pure JavaScript: `better-sqlite3` is a native addon, and while prebuilt binaries usually work, any Node-version mismatch on a reviewer's machine falls back to a node-gyp compilation (requiring Python and a C++ toolchain on Windows) — exactly the "zero-setup" failure mode this project must avoid. JSON files are also human-readable, which serves the educational goal: a student can open `data/grammars/*.json` and see precisely how a grammar is represented — the storage format is identical to the app's export format. The `models/grammarStore.js` abstraction (a small CRUD interface with atomic write-temp-then-rename semantics) means swapping in SQLite later is a one-file change, listed under *Future improvements*.

## Getting started

```bash
npm install     # install dependencies (pure JavaScript — no build tools needed)
npm run dev     # development server with auto-reload on http://localhost:3000
npm start       # production-style start
npm test        # run the Jest test suites
```

Optional configuration: copy `.env.example` to `.env` and adjust `PORT`, `NODE_ENV`, `DATA_DIR`. The app runs with sensible defaults if no `.env` exists.

## Project structure

```
├── server.js        # HTTP entry point (port binding, graceful shutdown)
├── app.js           # Express app assembly (middleware, static mounts, routes, error handling)
├── core/            # ★ shared, pure algorithm modules (browser + server + Jest use the SAME files)
├── routes/          # API route definitions
├── controllers/     # request/response handling (thin, delegates to services)
├── services/        # business logic around the core algorithms and storage
├── models/          # persistence layer (JSON file store)
├── utils/           # small shared helpers (HttpError, asyncHandler)
├── data/            # samples.json (built-in grammars) + grammars/ (user saves)
├── views/           # index.html (the single-page UI) + 404 page
├── public/          # css/, js/ (view modules), images/
├── docs/            # algorithm documentation (theory, pseudo-code, complexity)
└── tests/           # Jest test suites + shared fixtures
```

*(Full documentation — features, algorithms, screenshots, deployment guide, future improvements — is added in the documentation step.)*
