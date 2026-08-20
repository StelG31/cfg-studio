/**
 * scripts/benchmark.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Produce the empirical figures reported in docs/algorithms.md §9 — CYK
 *   versus Earley, measured on the six grammars the application ships.
 *
 *   This is a REPORTING utility, not a correctness check. It deliberately
 *   lives outside tests/ and outside `npm test`: nothing here asserts what
 *   the algorithms compute, only how long they take, and a timing figure is
 *   not something a test suite should be allowed to fail on. The one
 *   exception is engine agreement, which IS a correctness property and is
 *   checked here anyway, because a benchmark that silently compared a working
 *   engine against a broken one would report meaningless numbers.
 *
 *   It runs the shared core UNCHANGED — the same core/*.js files the browser
 *   and the Express services import — and times it with the same measure()
 *   the simulator uses, so the method behind the chapter's numbers and the
 *   method behind the on-screen ones are one implementation, not two.
 *
 * Usage:
 *   npm run bench
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertToCnf } from '../core/cnf.js';
import { runCyk } from '../core/cyk.js';
import { runEarley } from '../core/earley.js';
import { validateGrammar } from '../core/validator.js';
import { measure } from '../public/js/measure.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Iterations of each engine before any timing is recorded.
 *
 * Not a nicety. Measured cold, the very first convertToCnf() reads ~1.9 ms
 * and every later one ~0.15 ms: a factor of twelve that is V8 compiling the
 * function, not the conversion costing anything. Reporting it would put the
 * single most misleading number in the chapter.
 */
const WARMUP_ITERATIONS = 200;

/** Input lengths for the scaling table, up to core's 30-character cap. */
const SCALING_LENGTHS = [4, 8, 12, 16, 20, 24, 30];

/**
 * The grammars used for the scaling table, with a generator producing an
 * ACCEPTED string of the requested length. A rejected string would exercise
 * the same loops — both engines run to completion either way — but an
 * accepted one also exercises the backpointer bookkeeping.
 */
const SCALING_CASES = [
  {
    id: 'sample-anbn',
    note: 'unambiguous',
    make: (n) => 'a'.repeat(n / 2) + 'b'.repeat(n / 2),
  },
  {
    id: 'sample-balanced-parentheses',
    note: 'ambiguous',
    make: (n) => '()'.repeat(n / 2),
  },
  {
    id: 'sample-equal-as-bs',
    note: 'ambiguous',
    make: (n) => 'ab'.repeat(n / 2),
  },
];

/* ------------------------------------------------------------------------ */
/* Formatting                                                                */
/* ------------------------------------------------------------------------ */

const ms = (value) => `${value.toFixed(3)} ms`;
const pad = (value, width) => String(value).padStart(width);
const padEnd = (value, width) => String(value).padEnd(width);

/* ------------------------------------------------------------------------ */
/* Measurement                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Run both engines over one string and return the two timings, the two step
 * counts and the agreed verdict.
 *
 * @param {object} grammar    The grammar as written, for Earley.
 * @param {object} cnfGrammar The converted grammar, for CYK.
 * @param {string} input      The string to parse.
 * @returns {{accepted: boolean, earleyMs: number, earleySteps: number,
 *            cykMs: number, cykSteps: number}}
 * @throws {Error} when the engines disagree.
 */
function runBoth(grammar, cnfGrammar, input) {
  const earley = measure(() => runEarley(grammar, input));
  const cyk = measure(() => runCyk(cnfGrammar, input));

  if (earley.value.accepted !== cyk.value.accepted) {
    throw new Error(
      `The engines disagree on "${input}": Earley says ${earley.value.accepted}, ` +
        `CYK says ${cyk.value.accepted}. That is a defect in one of them, never a ` +
        'property of the grammar — every timing below would be meaningless until ' +
        'it is fixed.'
    );
  }

  return {
    accepted: earley.value.accepted,
    earleyMs: earley.ms,
    earleySteps: earley.value.steps.length,
    cykMs: cyk.ms,
    cykSteps: cyk.value.steps.length,
  };
}

/**
 * Compile the hot paths before anything is timed.
 *
 * @param {object} grammar
 * @param {object} cnfGrammar
 * @param {string} input A string of representative length for this grammar.
 */
function warmUp(grammar, cnfGrammar, input) {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    runEarley(grammar, input);
    runCyk(cnfGrammar, input);
    convertToCnf(grammar);
  }
}

/* ------------------------------------------------------------------------ */
/* Report sections                                                           */
/* ------------------------------------------------------------------------ */

function printHeader() {
  console.log('CFG Studio — CYK versus Earley, measured');
  console.log(
    `${process.version} · ${os.platform()} ${os.arch()} · ${os.cpus()[0].model.trim()}`
  );
  console.log(
    'Method: measure() from public/js/measure.js — a run under 1 ms is repeated\n' +
      '        within a ~20 ms budget and the mean reported. ' +
      `${WARMUP_ITERATIONS} warm-up iterations\n` +
      '        per grammar before any figure is recorded. Absolute values are\n' +
      '        machine-specific; step counts and ratios are not.'
  );
  console.log('');
}

/**
 * Section 1 — the six shipped grammars, each on its own saved test strings.
 *
 * @param {object[]} samples The parsed data/samples.json.
 */
function reportSamples(samples) {
  console.log('1. The six sample grammars, on their own saved test strings');
  console.log('   (means per string, accepted and rejected strings together)');
  console.log('');

  const head =
    `${padEnd('Grammar', 30)}${pad('P', 3)}${pad('CNF P', 7)}${pad('Conversion', 13)}` +
    `${pad('Earley', 11)}${pad('steps', 8)}${pad('CYK', 11)}${pad('steps', 8)}` +
    `${pad('Expected', 10)}`;
  console.log(`   ${head}`);
  console.log(`   ${'-'.repeat(head.length)}`);

  for (const grammar of samples) {
    const findings = validateGrammar(grammar);
    if (!findings.valid) {
      throw new Error(
        `Sample "${grammar.name}" does not validate — fix it before benchmarking.`
      );
    }

    const cnfGrammar = convertToCnf(grammar).result;
    const strings = [...grammar.testStrings.accept, ...grammar.testStrings.reject];

    warmUp(grammar, cnfGrammar, strings[0]);

    const conversion = measure(() => convertToCnf(grammar));

    let earleyMs = 0;
    let earleySteps = 0;
    let cykMs = 0;
    let cykSteps = 0;
    let asExpected = 0;

    for (const input of strings) {
      const run = runBoth(grammar, cnfGrammar, input);
      earleyMs += run.earleyMs;
      earleySteps += run.earleySteps;
      cykMs += run.cykMs;
      cykSteps += run.cykSteps;
      if (run.accepted === grammar.testStrings.accept.includes(input)) asExpected += 1;
    }

    const n = strings.length;
    console.log(
      `   ${padEnd(grammar.name, 30)}${pad(grammar.productions.length, 3)}` +
        `${pad(cnfGrammar.productions.length, 7)}${pad(ms(conversion.ms), 13)}` +
        `${pad(ms(earleyMs / n), 11)}${pad(Math.round(earleySteps / n), 8)}` +
        `${pad(ms(cykMs / n), 11)}${pad(Math.round(cykSteps / n), 8)}` +
        `${pad(`${asExpected}/${n}`, 10)}`
    );
  }
  console.log('');
}

/**
 * Section 2 — how each engine scales with the length of the input.
 *
 * The saved test strings are 2-6 characters, far too short to show an
 * asymptotic difference. This section generates longer ones on grammars
 * whose language makes that possible.
 *
 * @param {object[]} samples The parsed data/samples.json.
 */
function reportScaling(samples) {
  console.log('2. Scaling with input length (generated accepted strings)');
  console.log('');

  for (const scalingCase of SCALING_CASES) {
    const grammar = samples.find((sample) => sample.id === scalingCase.id);
    const cnfGrammar = convertToCnf(grammar).result;

    warmUp(grammar, cnfGrammar, scalingCase.make(6));

    console.log(
      `   ${grammar.name} — ${scalingCase.note}, ` +
        `${cnfGrammar.productions.length} CNF productions`
    );
    const head =
      `${pad('n', 5)}${pad('Earley', 12)}${pad('steps', 8)}${pad('CYK', 12)}` +
      `${pad('steps', 8)}${pad('CYK/Earley', 13)}`;
    console.log(`   ${head}`);
    console.log(`   ${'-'.repeat(head.length)}`);

    for (const length of SCALING_LENGTHS) {
      const input = scalingCase.make(length);
      const run = runBoth(grammar, cnfGrammar, input);
      console.log(
        `   ${pad(input.length, 5)}${pad(ms(run.earleyMs), 12)}${pad(run.earleySteps, 8)}` +
          `${pad(ms(run.cykMs), 12)}${pad(run.cykSteps, 8)}` +
          `${pad(`${(run.cykMs / run.earleyMs).toFixed(2)}x`, 13)}`
      );
    }
    console.log('');
  }
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                               */
/* ------------------------------------------------------------------------ */

function main() {
  const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'samples.json'), 'utf8'));

  printHeader();
  reportSamples(samples);
  reportScaling(samples);

  console.log('Both engines agreed on every string above.');
}

main();
