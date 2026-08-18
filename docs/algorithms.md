# CFG Studio — Algorithm Documentation

This document explains every algorithm implemented in `core/` **before** its implementation, following the structure: *Theory → Pseudo-code → Complexity → Implementation details*. The corresponding source files contain the same ideas as inline comments; this file is the connected, thesis-ready narrative.

**Contents**

1. [The grammar model and production tokenization](#1-the-grammar-model-and-production-tokenization) — `core/grammar.js`
2. [Grammar validation](#2-grammar-validation) — `core/validator.js`
3. [Conversion to Chomsky Normal Form](#3-conversion-to-chomsky-normal-form) — `core/cnf.js`
4. [The CYK membership algorithm](#4-the-cyk-membership-algorithm) — `core/cyk.js`
5. [Parse-tree reconstruction](#5-parse-tree-reconstruction) — `core/parser.js`
6. [The Earley recogniser](#6-the-earley-recogniser) — `core/earley.js`
7. [Earley parse-tree reconstruction](#7-earley-parse-tree-reconstruction) — `core/earley-tree.js`
8. [Parse-tree layout and rendering](#8-parse-tree-layout-and-rendering) — `public/js/tree.js`
9. [Choosing an engine, and measuring the choice](#9-choosing-an-engine-and-measuring-the-choice) — `public/js/engines.js`

---

## 1. The grammar model and production tokenization

### Theory

A **context-free grammar** is a 4-tuple **G = (V, Σ, P, S)** where

- **V** is a finite set of *variables* (non-terminals),
- **Σ** is a finite set of *terminals* with V ∩ Σ = ∅,
- **P ⊆ V × (V ∪ Σ)\*** is a finite set of *productions* A → α,
- **S ∈ V** is the *start symbol*.

CFG Studio represents this tuple literally as a JSON document:

```json
{
  "name": "Balanced Parentheses",
  "variables": ["S"],
  "terminals": ["(", ")"],
  "startSymbol": "S",
  "productions": [
    { "left": "S", "right": ["(", "S", ")"] },
    { "left": "S", "right": ["S", "S"] },
    { "left": "S", "right": [] }
  ]
}
```

Two representation decisions matter:

1. **The right-hand side is an array of symbols, not a string.** The string `"AB"` is ambiguous — is it the variable `AB`, or `A` followed by `B`? An array (`["A","B"]` vs `["AB"]`) removes the ambiguity permanently: after a production is parsed once, no algorithm ever needs to re-tokenize it.
2. **ε (the empty string) is the empty array `[]`.** This makes "is this an ε-production?" a trivial `right.length === 0` check.

**Symbol conventions** (JFLAP-inspired): variable names match `[A-Z][A-Za-z0-9_]*` (multi-character names are required because CNF conversion invents fresh variables like `S0`, `T_a`, `X1`); terminals are single non-uppercase characters (so a CYK input string needs no tokenizer of its own — every character is one terminal).

### Tokenizing a production's right-hand side

Users type productions as text (`S -> ( S ) | ε`). The right-hand side must be split into declared symbols. Because the declared symbol set is known, we use **longest-match (maximal munch) scanning** — the same principle a lexer uses:

```
function TOKENIZE(text, symbols):            # symbols sorted by length, longest first
    tokens ← []; i ← 0
    while i < |text|:
        if text[i] is whitespace: i ← i+1; continue
        match ← first s in symbols with text.startsWith(s, i)   # longest wins
        if no match: return error at position i
        tokens.append(match); i ← i + |match|
    return tokens
```

Longest-first ordering guarantees that with declared variables `A` and `AB`, the input `ABc` tokenizes as `[AB, c]`, never `[A, B, c]`. A whole alternative equal to `ε`, `epsilon`, `eps`, `λ` or `lambda` denotes the empty string (checked *before* tokenization; symbols that could collide with an alias can always be separated by spaces, e.g. `e p s`).

### Complexity

For a right-hand side of length *n* and *k* declared symbols: **O(n · k)** worst case (each position tries every symbol prefix) — with the constant-size symbol sets of classroom grammars, effectively linear.

### Implementation details (`core/grammar.js`)

- Pure ES module, zero dependencies, no DOM/Node APIs — the same file is imported by the browser, the Express services, and Jest.
- Provides: symbol predicates (`isValidVariableName`, `isValidTerminalSymbol`), `tokenizeRhs` (with exact error positions for editor feedback), `parseProductionLine` (splits `LHS -> alt | alt`, accepts both `->` and `→`), formatting helpers (`productionToString`, `grammarToText` for grouped display), duplicate detection keys (`productionKey`), deep cloning, and JSON (de)serialization with structural checks for the import feature.
- Reserved characters that can never be terminals: `|` (alternative separator), `ε`/`λ` (empty-string aliases) and whitespace. The arrow `->` is only special as the *first* occurrence in a production line, so `-` and `>` remain usable as terminals.

---

## 2. Grammar validation

### Theory

Validation answers two different questions, and the distinction matters for the user experience:

- **Errors** — the object is not a well-formed CFG at all: a missing or undeclared start symbol, symbols that violate the naming conventions, a symbol declared as both variable and terminal, productions whose left side is not a declared variable, right-hand sides that use undeclared symbols, duplicate declarations or duplicate productions, or no productions at all. Algorithms must refuse to run on such input.
- **Warnings** — the grammar is well-formed but contains *useless structure*, detected with two classic fixpoint analyses (Hopcroft & Ullman's "useless symbol" elimination, here used only diagnostically):
  - a variable is **generating** if it can derive some string of terminals;
  - a variable is **reachable** if it appears in some sentential form derived from S.

  Non-generating or unreachable variables (and terminals that appear in no production) do not make the grammar invalid — they simply cannot influence the language, which is exactly what a student should be told. A non-generating *start symbol* earns the strongest warning: L(G) = ∅.

### Pseudo-code

**Generating variables** (bottom-up fixpoint):

```
GEN ← ∅
repeat until no change:
    for each production A → X1…Xk:
        if every Xi is a terminal or in GEN:   # ε-production: k = 0, trivially true
            GEN ← GEN ∪ {A}
```

**Reachable variables** (top-down breadth-first search):

```
REACH ← {S}; queue ← [S]
while queue not empty:
    A ← pop(queue)
    for each production A → X1…Xk:
        for each Xi that is a variable and Xi ∉ REACH:
            REACH ← REACH ∪ {Xi}; push(queue, Xi)
```

### Complexity

Both analyses are **O(|P| · L)** per fixpoint round (L = longest right-hand side) with at most |V| rounds — O(|V| · |P| · L) worst case; the direct checks (naming, duplicates, undefined symbols) are a single O(|P| · L) pass over the grammar with set lookups. Instantaneous at classroom scale, fast enough to run on every keystroke.

### Implementation details (`core/validator.js`)

- `validateGrammar(grammar)` returns `{ valid, errors[], warnings[] }`; every finding is `{ code, severity, message, context }` with a **stable machine-readable code** (`START_NOT_DECLARED`, `UNDEFINED_SYMBOL`, `DUPLICATE_PRODUCTION`, …) so tests assert codes, never message text.
- Warnings are computed **only when there are no errors** — running reachability over a structurally broken grammar would produce misleading noise.
- `computeGenerating` and `computeReachable` are exported separately: the CNF converter reuses exactly these analyses for its useless-symbol cleanup stage (single source of truth).
- Messages are written for students: they name the offending symbol/production and say what to do about it.

---

## 3. Conversion to Chomsky Normal Form

### Theory

A grammar is in **Chomsky Normal Form (CNF)** when every production has one of the forms

- **A → B C** (exactly two variables),
- **A → a** (exactly one terminal),
- **S → ε** — only for the start symbol, and only if ε ∈ L(G); the start symbol must then never appear on a right-hand side.

Every CFG can be converted into an equivalent CNF grammar (equivalent = same language). CNF matters here because the CYK algorithm requires it: binary rules are what make the dynamic-programming decomposition of CYK work.

The conversion is a pipeline of five classic transformations plus a cleanup. **Order matters.** CFG Studio uses

> **START → TERM → BIN → DEL → UNIT → CLEANUP**

because running **BIN before DEL** keeps the algorithm polynomial: DEL must expand every subset of nullable symbols in a right-hand side (2^k variants for k nullable occurrences), and after binarization k ≤ 2, so at most 4 variants per rule — whereas DEL on a raw right-hand side of 10 nullable symbols would create 1024 rules. Running **UNIT last** is equally deliberate: DEL can *create* new unit productions (A → BC with C nullable yields A → B), so eliminating units earlier would have to be redone.

### The six stages

1. **START — fresh start symbol.** If the start symbol S appears on any right-hand side, add a new start S₀ with S₀ → S. Guarantees the start symbol never occurs on a right-hand side, which later makes S₀ → ε safe (nothing can duplicate S₀ mid-derivation). If S never appears on a right-hand side, the stage is a documented no-op.

2. **TERM — isolate terminals.** In every right-hand side of length ≥ 2, replace each terminal a by a fresh variable T_a and add T_a → a. After TERM, terminals occur only in rules of the form A → a.

3. **BIN — binarize.** Replace every rule A → X₁X₂…X_k (k ≥ 3) by a cascade A → X₁N₁, N₁ → X₂N₂, …, N_{k−2} → X_{k−1}X_k with fresh variables N_i. After BIN, every right-hand side has length ≤ 2.

4. **DEL — eliminate ε-productions.** Compute the **nullable set** by fixpoint (A is nullable iff some A → α exists with every symbol of α nullable; ε-productions are the base case). Then for every rule, add every variant obtained by deleting any subset of nullable occurrences (dropping variants that become empty), and remove all ε-productions. If the start symbol was nullable, re-add S₀ → ε — the single ε-rule CNF allows.

5. **UNIT — eliminate unit productions.** Compute the **unit-pair closure**: (A, B) is a unit pair iff A ⇒* B using only unit rules (A → B with B a variable). For every unit pair (A, B) and every *non-unit* rule B → α, add A → α; then delete all unit rules. Handles unit cycles (A → B, B → A) correctly because the closure is a reachability computation, not a rewriting loop.

6. **CLEANUP — remove useless symbols.** First drop non-generating variables (reusing `computeGenerating` from the validator), then drop unreachable ones (`computeReachable`) — in that order, since removing non-generating rules can make further variables unreachable. The terminal alphabet is deliberately left unchanged: Σ is part of the language's definition, not of the rules.

### Pseudo-code (DEL, the subtlest stage)

```
NULLABLE ← fixpoint as above
P' ← ∅
for each rule A → X1…Xk in P (k ≥ 1):
    positions ← { i | Xi ∈ NULLABLE }
    for each subset D of positions:               # ≤ 2^k, and k ≤ 2 after BIN
        β ← X1…Xk with the positions in D deleted
        if β ≠ ε: P' ← P' ∪ { A → β }
if S ∈ NULLABLE: P' ← P' ∪ { S → ε }
```

### Complexity

START O(|P|); TERM O(|P|·L); BIN O(|P|·L); DEL O(|P|·2²) = O(|P|) after BIN (the pipeline order is exactly what makes this linear); UNIT O(|V|² + |V|·|P|) for the closure and pull-up; CLEANUP O(|V|·|P|·L). Total: **polynomial in the size of the grammar**, dominated by UNIT. The resulting grammar is at most a constant factor larger except for UNIT, which is bounded by |V|·|P|.

### Implementation details (`core/cnf.js`)

- `convertToCnf(grammar)` returns `{ original, alreadyCnf, steps[], result, emptyLanguage }`. Each step records `{ stage, title, explanation, changes[], grammar }` — `changes` entries are typed (`add` / `remove` / `replace`) and each carries a human-readable `reason`, which is what the UI renders as the per-step explanation. `grammar` is a deep snapshot after the stage, so the UI can show the full intermediate grammar at every point.
- Each stage is an exported pure function (`applyStart`, `applyTerm`, `applyBin`, `applyDel`, `applyUnit`, `removeUseless`) so tests can verify every invariant in isolation.
- Fresh names can never collide with user symbols: a namer tracks every used variable and appends counters (S₀ becomes `S0`, or `S01` if taken; terminals map to readable `T_a` when alphanumeric, `T1, T2, …` otherwise; BIN uses `X1, X2, …`).
- A grammar that is already in CNF is detected upfront (`isCnf`) and reported as a single explanatory no-op step.
- If the start symbol generates nothing, the result has no productions: the `emptyLanguage` flag lets the UI say "L(G) = ∅" explicitly instead of showing a bare grammar.

---

## 4. The CYK membership algorithm

### Theory

The **Cocke–Younger–Kasami** algorithm decides, for a grammar G in Chomsky Normal Form and a string w = w₁…wₙ, whether w ∈ L(G). It is a classic **dynamic-programming** algorithm built on one observation: in CNF, any derivation of a string of length ≥ 2 starts with a binary rule A → BC, where B derives a *prefix* and C the matching *suffix*. So define

> **V(i, l)** = the set of variables that derive the substring of w starting at position i with length l.

- **Base row (l = 1):** V(i, 1) = { A | A → wᵢ ∈ P } — read directly off the terminal rules.
- **Induction (l ≥ 2):** A ∈ V(i, l) iff there is a split length k (1 ≤ k < l) and a rule A → BC with B ∈ V(i, k) and C ∈ V(i+k, l−k). Every possible split is tried; the table is filled by increasing length, so both sub-cells are always ready.
- **Answer:** w ∈ L(G) iff S ∈ V(1, n). The empty string is a special case handled before the table: ε ∈ L(G) iff the rule S → ε exists (the only ε-rule CNF allows).

This is exactly why the CNF conversion (§3) exists in the pipeline: binary rules make "split into two halves" the *only* case the induction must consider.

### Pseudo-code

```
if n = 0: return (S → ε) ∈ P

for i ← 1 to n:                               # base row
    V(i,1) ← { A | A → w_i ∈ P }

for l ← 2 to n:                               # substring length
    for i ← 1 to n − l + 1:                   # start position
        for k ← 1 to l − 1:                   # split length
            for each rule A → B C ∈ P:
                if B ∈ V(i,k) and C ∈ V(i+k, l−k):
                    V(i,l) ← V(i,l) ∪ {A}      # + record backpointer (k, rule)

return S ∈ V(1,n)
```

### Complexity

Three nested loops over (l, i, k) give **O(n³)** cell-combinations, each scanning the binary rules: **O(n³ · |P|)** time and **O(n² · |V|)** space. CFG Studio caps the input at 30 characters — far beyond classroom examples, but keeps the animated table readable and the trace bounded (~n³/6 ≈ 4 500 recorded steps at the cap).

### Implementation details (`core/cyk.js`)

- `runCyk(grammar, input)` first checks its preconditions and throws typed errors (`GRAMMAR_NOT_CNF`, `INVALID_INPUT_CHAR` with the exact position, `INPUT_TOO_LONG`) so the UI and the API can show precise messages.
- Binary rules are pre-indexed in a map keyed by (B, C), so each split-combination is a hash lookup, not a rule scan.
- Every table entry keeps **all** its derivations (`{k, production}` backpointers, or the terminal production on the base row) — this is what §5 uses to reconstruct a parse tree, and keeping *all* of them (not just the first) preserves ambiguity information.
- Besides the table, `runCyk` emits a **step trace** for the animation: `begin` → one `init-cell` per position → one `combine` step per (cell, split) with the variables found and a sentence explaining why → `cell-done` summaries → `verdict`. The UI replays this trace; the algorithm itself runs to completion instantly.
- Cells are plain JSON objects (arrays, no Maps/Sets) so the same result object can travel over the REST API unchanged.

---

## 5. Parse-tree reconstruction

### Theory

CYK as presented in §4 answers only *yes/no*. To produce a **derivation tree**, each table entry additionally records *how* it was derived — its **backpointers**: on the base row, the terminal rule used; on higher rows, the pair (split length k, rule A → BC). A tree then falls out of a single top-down walk: start at the apex entry (S, cell (1, n)); at each entry follow its backpointer — a terminal rule ends the branch in a leaf, a split rule recurses into the two child cells (i, k, B) and (i+k, l−k, C).

Because entries keep **every** derivation, an ambiguous string has several valid trees; CFG Studio deterministically shows the first one recorded (the leftmost split found), which corresponds to the smallest split length. The tree is the derivation tree **of the CNF grammar** — mapping it back onto the original grammar's rules is a known refinement listed under Future improvements.

The same walk also yields the **leftmost derivation** shown next to the tree: expanding, at every step, the leftmost variable of the current sentential form is exactly a pre-order traversal of the tree.

### Pseudo-code

```
BUILD(i, l, A):
    entry ← table(i, l).entry(A);  d ← entry.derivations[0]
    if d is (terminal rule A → a):  return node(A, children = [leaf(a)])
    if d is (split k, rule A → BC): return node(A, children = [BUILD(i, k, B),
                                                               BUILD(i+k, l−k, C)])
tree ← BUILD(1, n, S)          # ε: a two-node tree S → ε, no table walk
```

### Complexity

The tree of a CNF derivation of a length-n string has exactly n leaves, n−1 internal binary nodes and n unary (pre-terminal) nodes — **O(n) nodes**, built in O(n) after the O(n³) CYK run.

### Implementation details (`core/parser.js`)

- `buildParseTree(cykResult)` returns `{symbol, span, production, children[]}` nodes (terminal leaves carry `terminal: true`; the ε case yields a two-node tree with an `epsilon` leaf), or `null` for rejected inputs — the UI decides what to say.
- `leftmostDerivation(tree)` returns the list of sentential forms from S to w, each an array of symbols — rendered under the tree as `S₀ ⇒ … ⇒ w`.
- Helper metrics (`countNodes`, `treeDepth`) feed the view's footer and the tests.

---

## 6. The Earley recogniser

### Theory

**Earley's algorithm** decides w ∈ L(G) for an **arbitrary** context-free grammar — no normal form, no restriction on the shape of the productions. In place of a table indexed by substrings it maintains n + 1 **columns** of *items*.

An **item** is a production with a marker (the *dot*) somewhere in its right-hand side, together with an **origin**:

> **A → α • β (j)** in column *c* means: some production of A began at position j, the parser has matched α against w_{j+1}…w_c, and it is now looking for β.

Column c holds every item consistent with the first c input symbols. Column 0 is seeded with **S → •γ (0)** for every rule of S. Three operations then close each column:

- **PREDICT** — `A → α • B β (j)` with B a variable: any rule of B could start here, so add **B → •γ (c)** for every B → γ.
- **SCAN** — `A → α • a β (j)` with a a terminal: if a = w_{c+1}, add **A → α a • β (j)** to column c+1. This is the only operation that consumes input, which is why the columns fill left to right.
- **COMPLETE** — `B → γ • (j)`: B has been recognised over w_{j+1}…w_c, so every item in column **j** whose dot sits before B moves its dot across it, the result landing in column c.

w ∈ L(G) iff column n contains **S → γ • (0)** for some rule S → γ.

Left recursion needs no special treatment. `E → • E + T (c)` predicts E, whose rules are already present in column c, so prediction reaches a fixpoint instead of recursing — exactly where a recursive-descent parser would fail to terminate.

### Pseudo-code

```
CHART[0] ← { S → •γ (0) : S → γ ∈ P }

for c ← 0 to n:
    for each item I in CHART[c]:                 # CHART[c] GROWS during this loop
        if I = A → α•Bβ (j), B a variable:       # PREDICT
            for each B → γ ∈ P:
                add B → •γ (c) to CHART[c]
            EPSILON-REPAIR(c, I, B)
        else if I = A → α•aβ (j), a a terminal:  # SCAN
            if c < n and a = w[c+1]:
                add A → αa•β (j) to CHART[c+1]
        else if I = B → γ• (j):                  # COMPLETE
            if j = c: remember (B, I) as an ε-completion of column c
            for each A → α•Bβ (i) in CHART[j]:   # bound re-read at every step
                add A → αB•β (i) to CHART[c]

accept iff S → γ• (0) ∈ CHART[n] for some rule S → γ
```

`add` is an **upsert** keyed on (production, dot, origin): an item never appears twice in a column, which is what makes the growing loop terminate.

### ε-productions: why COMPLETE must re-examine its own column

This is the classic subtle failure of Earley implementations (Aycock & Horspool, *Practical Earley Parsing*, 2002), and it is not a rare corner — four of CFG Studio's six sample grammars contain an ε-production.

When B derives ε the item **B → • (c)** is complete the instant it is predicted, and its origin is the column it lives in. COMPLETE must therefore scan *the column currently being built*, the one still growing beneath it. The main loop copes with that much on its own, because it re-reads the column's length at every step.

The real failure is one of **ordering**. Take

> S → A B  B → A c  A → ε

on the input `c`. Column 0 fills like this:

| # | item | added by |
|---|---|---|
| 0 | `S → •A B (0)` | seed |
| 1 | `A → • (0)` | PREDICT A from 0 |
| 2 | `S → A•B (0)` | COMPLETE 1, scanning column 0 |
| 3 | `B → •A c (0)` | PREDICT B from 2 |

Item 3 is waiting for an A — and A already derived ε here, at item 1. But the completer for item 1 ran while the column still ended at item 2, and it will never run again. Predicting A from item 3 produces `A → • (0)`, a **duplicate**, which the upsert discards, so no completion fires. `B → A•c (0)` is never created, the `c` is never scanned, and the parser reports c ∉ L(G) — although S ⇒ A B ⇒ B ⇒ A c ⇒ c.

The repair makes the *predictor* responsible for the completions it arrived too late for. Each column remembers which variables were completed in it with that column as their origin; whenever the dot of a newly examined item sits before such a variable, the predictor advances the dot itself:

```
EPSILON-REPAIR(c, I = A → α•Bβ (j), B):
    for each ε-completion (B, C) remembered in column c:
        add A → αB•β (j) to CHART[c], recording C as the subtree for B
```

**Why the two halves are exhaustive.** Take any waiting item W (dot before B) and any completion C of B with origin c, both in column c. If C entered the column after W, then C's own scan of the column finds W. If C entered before W, the repair fires when the main loop reaches W. One of the two always holds, so the pair is never missed — and since the upsert also discards a derivation it has already recorded, it is never counted twice either. A completion whose origin j is an *earlier* column needs no repair at all: column j stopped growing when the parser moved past it.

One point deserves stating plainly, because it is the trap. This is not a bug that surfaces on the obvious test cases: every one of the sample grammars, the nullable ones included, parses correctly *without* the repair. The four-rule grammar above was constructed specifically to expose the ordering, and it is what the regression test pins.

### Complexity

Each column holds O(|P| · n) distinct items — a production, a dot and an origin — and COMPLETE may pair each of them against the items of one earlier column, giving **O(n³)** in the worst case, the standard bound for general context-free recognition. The bound tightens by itself on well-behaved grammars: **O(n²)** for unambiguous grammars and **O(n)** for the LR(k)-recognisable ones, simply because fewer items survive in each column. No property of the grammar has to be declared or tested to obtain this.

CFG Studio caps the input at 30 characters, keeping the recorded trace bounded and the chart readable.

### Implementation details (`core/earley.js`)

- `runEarley(grammar, input)` returns `{accepted, input, n, startSymbol, chart, steps}` — plain JSON throughout, so the result travels over the REST API unchanged.
- Preconditions throw a typed `EarleyError` carrying a stable code: `GRAMMAR_INVALID`, `INVALID_INPUT`, `INPUT_TOO_LONG`, `INVALID_INPUT_CHAR` (the last naming the exact position). The grammar check follows `convertToCnf`'s precedent — `runEarley` receives the user's *original* grammar and is reachable directly, so it validates rather than assuming. It also earns something concrete: afterwards every right-hand-side symbol is known to be a declared variable or a declared terminal, so the main loop needs no defensive branch.
- The empty string needs **no special case**. With n = 0 the chart is the single column 0, and a rule S → ε is seeded there as the already-complete item `S → • (0)`, which the ordinary acceptance test finds like any other.
- Items are deduplicated per column on a key of (production, dot, origin) joined with U+001F — the same collision-free separator `productionKey` uses.
- Every item keeps **all** the derivations that reached it, not just the first: that preserves ambiguity information and gives §7 its backpointers. A derivation is `{type:'scan', back}` or `{type:'complete', back, child}`, where `back` points at the same production one dot earlier and `child` at the completed item that was consumed.
- Besides the chart, `runEarley` emits a **step trace** for the animation: `begin` → `predict` / `scan` / `complete` per operation → `column-done` per column → `verdict`. Completions produced by the ε repair carry `nullableRepair: true` and say so in their explanation, so the ε case is visible to the reader instead of buried in the machinery.

---

## 7. Earley parse-tree reconstruction

### Theory

The chart says *that* the input parses; the backpointers say *how*. Every item records the one step by which its dot advanced: a SCAN consumed a terminal, a COMPLETE consumed an entire sub-derivation. Reading those records backwards turns an item into a tree node.

For a completed item **A → X₁…X_m • (j)** in column c the children are recovered by walking the chain from dot m down to dot 0. Each step yields one child, right to left: a scan step contributes a terminal leaf, a completion step contributes the subtree of the item it consumed. The node spans w_{j+1}…w_c, is labelled A, and carries the production A → X₁…X_m itself.

That last point is the reason this module exists. The nodes are labelled with the productions **the user wrote** — n-ary, exactly as typed. Nothing has to be mapped back from a converted grammar, because nothing was ever converted.

### Pseudo-code

```
BUILD(item):                        # item is complete: A → X₁…X_m • (j), in column c
    children ← []
    cursor ← item
    while cursor.dot > 0:
        d ← cursor.derivations[0]
        if d is a scan:        prepend leaf(w[d.back.column + 1]) to children
        if d is a completion:  prepend BUILD(d.child)             to children
        cursor ← d.back
    if m = 0: children ← [ ε-leaf ]
    return node(A, span = (j, c − j), production = A → X₁…X_m, children)

tree ← BUILD(the completed S-item with origin 0 in column n)
```

### Why the walk terminates

A grammar with a unit cycle (A → B, B → A) or with nullable variables admits infinitely many derivation trees for the same string, and zero-width children make any span-shrinking argument useless — so a walk that chose its derivations carelessly could descend forever.

Taking `derivations[0]` settles it. That entry is the derivation which **created** the item, so both pointers it carries — the predecessor and the consumed child — refer to items that already existed at that moment. Every step of the walk therefore moves to an item created strictly earlier in the chart. That is a well-founded order, so the descent must stop: no visited set, no depth limit, and the same input always yields the same tree.

### Complexity

A single pass over the backpointers, one node per symbol of the productions applied along the chosen derivation: **O(number of nodes in the tree)**, after the recognition work of §6. For an ambiguous string one tree is produced — deterministically the first — while the remaining derivations stay in the chart.

### Implementation details (`core/earley-tree.js`)

- `buildEarleyTree(earleyResult)` returns the root node, or `null` for a rejected run.
- The node shape is deliberately **identical** to the one `core/parser.js` documents: `{symbol, span, production, children}`, leaves flagged `terminal: true`, the ε leaf additionally `epsilon: true`. `frontier`, `countNodes`, `treeDepth` and `leftmostDerivation` are therefore shared rather than reimplemented, and the renderer of §8 draws either kind of tree without knowing which module produced it.
- A node for an ε-production carries the single ε leaf, so `frontier` skips it and the tree's yield still spells the input exactly.
- An inconsistent chart raises rather than silently mis-building — the same guard `buildParseTree` uses.

---

## 8. Parse-tree layout and rendering

### Theory

Drawing a tidy tree means solving one constraint problem: children centred under parents, no overlaps, minimal width. For **binary trees with all leaves at known positions** — exactly what CNF derivation trees are — the classic simplification of the Reingold–Tilford method suffices:

1. **x-coordinates:** a post-order pass assigns each *leaf* the next free horizontal slot; every internal node sits at the midpoint of its children's x-positions.
2. **y-coordinates:** the node's depth.

This is O(n), produces no crossings, and keeps uniform spacing — visually indistinguishable from full Reingold–Tilford on these trees.

### Implementation details (`public/js/tree.js`)

- Pure SVG, hand-rolled — no D3 or drawing library. Nodes are rounded rectangles (indigo for variables, teal for terminal leaves, grey italic ε), edges are plain lines drawn parent-bottom → child-top.
- **Interaction** is implemented directly on the SVG `viewBox`: wheel-zoom around the cursor (screen → SVG coordinate conversion via `getBoundingClientRect`), pointer-drag panning, +/− buttons and **fit-to-view** (viewBox reset to the content bounding box with padding). Works with mouse and touch (pointer events).
- Colours are set as SVG attributes, not CSS classes, so the **Download SVG** export produces a standalone file that renders identically outside the app.

---

## 9. Choosing an engine, and measuring the choice

### Theory

CYK and Earley decide **the same question** — is w ∈ L(G)? — by opposite routes.

CYK is a bottom-up dynamic program that requires Chomsky Normal Form, so the
grammar must be *converted* first. Conversion is a rewriting of the grammar
that preserves the language but not the shape: it introduces fresh variables
(`X1`, `T2`, `S0`…) that the author never wrote, and every parse tree CYK
produces is therefore expressed in that invented vocabulary.

Earley is a top-down chart parser that imposes no normal form. It runs on the
grammar exactly as written, and its parse trees carry only the author's own
symbols and rules.

Both are O(n³) in the worst case, so the choice is not one of asymptotics.
What differs is the **constant factor**, the **preprocessing** and the **shape
of the answer**:

| | CYK | Earley |
|---|---|---|
| Input grammar | must be in CNF | any valid CFG |
| Preprocessing | conversion, once per grammar | none |
| Tree vocabulary | the converted grammar's | the author's own |
| Tree arity | strictly binary | n-ary, mirrors the rules |
| Behaviour on unambiguous grammars | always Θ(n³) | often far below the bound |

Because the two share no code path beyond `core/grammar.js`, agreement between
them is a genuine cross-check rather than a tautology: any string on which
they differ is a bug in one of the implementations, never a property of the
grammar. The application treats a disagreement that way — it is reported as a
defect, not shown as a result.

### What the application measures

`public/js/engines.js` runs a string through one engine or both, and when both
are asked for it reports **three separate figures**:

1. the Earley parse,
2. the CYK parse,
3. the CNF conversion.

The third is deliberately **not** folded into the second. A grammar is
converted once and the CNF result reused for every subsequent string, so
charging the conversion to each string would overstate CYK by a factor of
however many strings were run. Reported separately and labelled *one-off per
grammar*, the reader can add it back where it belongs: to the first string
only, or amortised across a batch.

### Measuring something too fast to measure

`performance.now()` is deliberately coarsened by browsers — typically clamped
to 0.1 ms, and coarser again under privacy hardening. A classroom grammar over
a 10-character string parses well inside that clamp, so a single sample would
read `0.000 ms` for both engines: not a fast result, a *missing* one, and
worthless to a comparison.

`measure()` therefore samples adaptively. It runs the work once for its
result; if that took less than 1 ms it repeats the call within a ~20 ms budget
and reports the **mean over the repetitions**, along with the repetition count
so the figure on screen can say *mean of 172 runs*. The count is displayed
rather than hidden because a mean of many runs and a single timing are
different kinds of number, and a reader comparing them deserves to know which
one they are looking at.

Two caveats worth stating for any measurement taken this way:

- Repetition measures **warm** performance. The JIT has compiled the code and
  the caches are hot, which flatters both engines — equally, but it is not
  cold-start cost.
- The batch runner yields to the browser between strings, so its wall-clock
  duration includes that yielding and is **not** a parsing measurement. Use
  the per-string figures, not the time the batch appears to take.
