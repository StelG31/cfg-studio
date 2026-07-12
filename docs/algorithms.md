# CFG Studio — Algorithm Documentation

This document explains every algorithm implemented in `core/` **before** its implementation, following the structure: *Theory → Pseudo-code → Complexity → Implementation details*. The corresponding source files contain the same ideas as inline comments; this file is the connected, thesis-ready narrative.

**Contents**

1. [The grammar model and production tokenization](#1-the-grammar-model-and-production-tokenization) — `core/grammar.js`
2. [Grammar validation](#2-grammar-validation) — `core/validator.js`
3. [Conversion to Chomsky Normal Form](#3-conversion-to-chomsky-normal-form) — `core/cnf.js`
4. [The CYK membership algorithm](#4-the-cyk-membership-algorithm) — `core/cyk.js`
5. [Parse-tree reconstruction](#5-parse-tree-reconstruction) — `core/parser.js`
6. [Parse-tree layout and rendering](#6-parse-tree-layout-and-rendering) — `public/js/tree.js`

*(Sections are filled in step by step, immediately before each module is implemented.)*
