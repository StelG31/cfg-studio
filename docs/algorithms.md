# CFG Studio — Algorithm Documentation

This document explains every algorithm implemented in `core/` **before** its implementation, following the structure: *Theory → Pseudo-code → Complexity → Implementation details*. The corresponding source files contain the same ideas as inline comments; this file is the connected, thesis-ready narrative.

**Contents**

1. [The grammar model and production tokenization](#1-the-grammar-model-and-production-tokenization) — `core/grammar.js`
2. [Grammar validation](#2-grammar-validation) — `core/validator.js`
3. [Conversion to Chomsky Normal Form](#3-conversion-to-chomsky-normal-form) — `core/cnf.js`
4. [The CYK membership algorithm](#4-the-cyk-membership-algorithm) — `core/cyk.js`
5. [Parse-tree reconstruction](#5-parse-tree-reconstruction) — `core/parser.js`
6. [Parse-tree layout and rendering](#6-parse-tree-layout-and-rendering) — `public/js/tree.js`

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


