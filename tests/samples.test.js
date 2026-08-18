/**
 * tests/samples.test.js
 * ---------------------------------------------------------------------------
 * Tests for the SHIPPED sample grammars (data/samples.json):
 *   - every sample is structurally sound and semantically valid,
 *   - every string it claims is accepted really is, and every string it
 *     claims is rejected really is not,
 *   - both engines agree on all of them.
 *
 * Why this exists when tests/earley.test.js already cross-checks Earley
 * against CYK: that suite runs over the hand-written fixtures in
 * tests/fixtures/grammars.js, which are separate objects from the file the
 * application actually serves. Nothing tied the two together, so a typo in
 * samples.json — a string listed under the wrong heading — would have
 * shipped silently. tests/api.test.js only asserts the lists are non-empty;
 * it never runs a single string in them.
 *
 * These are also the strings the batch runner loads when a student presses
 * "Run saved test strings" on a sample, so they are the first regression
 * suite anyone using the app will see. They had better be right.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGrammar } from '../core/grammar.js';
import { validateGrammar } from '../core/validator.js';
import { convertToCnf } from '../core/cnf.js';
import { runCyk } from '../core/cyk.js';
import { runEarley } from '../core/earley.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_PATH = path.join(__dirname, '..', 'data', 'samples.json');

/** Read once — the file is static and every test below wants the same list. */
const samples = JSON.parse(await fs.readFile(SAMPLES_PATH, 'utf8'));

/** ε reads better than "" in a test name. */
const shown = (value) => (value === '' ? 'ε' : value);

describe('the shipped samples are well formed', () => {
  test('there are six of them, each with a unique id', () => {
    expect(samples).toHaveLength(6);
    expect(new Set(samples.map((s) => s.id)).size).toBe(6);
  });

  test.each(samples.map((s) => [s.name, s]))('%s is a valid grammar', (_name, sample) => {
    expect(validateGrammar(createGrammar(sample)).valid).toBe(true);
  });

  test.each(samples.map((s) => [s.name, s]))('%s declares both lists', (_name, sample) => {
    expect(sample.testStrings.accept.length).toBeGreaterThan(0);
    expect(sample.testStrings.reject.length).toBeGreaterThan(0);
  });

  test.each(samples.map((s) => [s.name, s]))(
    '%s lists no string as both accepted and rejected',
    (_name, sample) => {
      const accepted = new Set(sample.testStrings.accept);
      const both = sample.testStrings.reject.filter((s) => accepted.has(s));
      expect(both).toEqual([]);
    }
  );
});

/* ------------------------------------------------------------------------ */
/* The declared expectations are the truth                                   */
/* ------------------------------------------------------------------------ */

/** Every (sample, string, expectation) triple, flattened for test.each. */
const cases = samples.flatMap((sample) => [
  ...sample.testStrings.accept.map((value) => [sample.name, sample, value, true]),
  ...sample.testStrings.reject.map((value) => [sample.name, sample, value, false]),
]);

describe('every declared test string gets the verdict it claims', () => {
  test.each(cases)('%s: %#', (_name, sample, value, expected) => {
    const grammar = createGrammar(sample);
    const cnf = convertToCnf(grammar).result;

    const earley = runEarley(grammar, value).accepted;
    const cyk = runCyk(cnf, value).accepted;

    // Compared as objects so a failure names the string it was about rather
    // than just reporting "expected true, got false".
    expect({ string: shown(value), earley, cyk }).toEqual({
      string: shown(value),
      earley: expected,
      cyk: expected,
    });
  });
});

describe('the two engines agree on every sample', () => {
  // The engines share no code path beyond core/grammar.js — Earley runs the
  // grammar as written, CYK runs its CNF conversion — so any disagreement
  // here is a real bug in one of them, never a property of the grammar.
  test.each(cases)('%s: %#', (_name, sample, value) => {
    const grammar = createGrammar(sample);
    const cnf = convertToCnf(grammar).result;
    expect(runEarley(grammar, value).accepted).toBe(runCyk(cnf, value).accepted);
  });
});

/* ------------------------------------------------------------------------ */
/* The samples carry their test strings into the app                         */
/* ------------------------------------------------------------------------ */

describe('test strings survive the trip into the editor', () => {
  // grammars-view.js loads a sample with createGrammar(sample). Before
  // testStrings was part of the model that call silently dropped them, so
  // this is the assertion that keeps the "load a sample, press run" path
  // working.
  test.each(samples.map((s) => [s.name, s]))('%s keeps both lists', (_name, sample) => {
    const grammar = createGrammar(sample);
    expect(grammar.testStrings).toEqual(sample.testStrings);
  });
});
