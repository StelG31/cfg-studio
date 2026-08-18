/**
 * public/js/views/tree-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The Parse Tree section: builds the derivation tree of the last ACCEPTED
 *   parse run, renders it with the interactive SVG renderer (tree.js), and
 *   shows the leftmost derivation the tree encodes.
 *
 *   WHICH TREE depends on which engine ran, and the difference is the point:
 *
 *     Earley  builds from the chart (core/earley-tree.js) and labels every
 *             node with a production of the grammar the user WROTE.
 *     CYK     builds from the table's backpointers (core/parser.js) and
 *             labels nodes with the CONVERTED grammar's productions, so
 *             symbols such as X1 appear that the user never declared.
 *
 *   The footer says which of the two is on screen, because otherwise those
 *   invented symbols look like a bug. After a compare run both trees exist
 *   and a toggle in the card header switches between them.
 *
 *   State handling: listens for 'parse-computed' and re-renders; edits to the
 *   grammar invalidate everything (app.js clears state.run) and the section
 *   falls back to its empty state.
 *
 * DOM contract (views/index.html):
 *   #treeCanvas #treeMeta #treeDerivationCard #treeDerivation #treeGrammarChoice
 *   #btnTreeZoomIn #btnTreeZoomOut #btnTreeFit #btnTreeDownload
 */

import { EPSILON } from '/core/grammar.js';
import { buildParseTree, leftmostDerivation, countNodes, treeDepth } from '/core/parser.js';
import { buildEarleyTree } from '/core/earley-tree.js';
import { state, events } from '../app.js';
import { escapeHtml, showToast } from '../ui.js';
import { TreeRenderer } from '../tree.js';

const els = {};
let renderer = null;
let currentTree = null;

/**
 * Which grammar's tree to show when BOTH are available (compare runs only):
 * 'original' (Earley) or 'cnf' (CYK). Defaults to the original, because that
 * is the grammar the user can actually recognise.
 */
let preferredTreeGrammar = 'original';

export function init() {
  els.canvas = document.getElementById('treeCanvas');
  els.meta = document.getElementById('treeMeta');
  els.derivationCard = document.getElementById('treeDerivationCard');
  els.derivation = document.getElementById('treeDerivation');
  els.grammarChoice = document.getElementById('treeGrammarChoice');

  renderer = new TreeRenderer(els.canvas);

  document.getElementById('btnTreeZoomIn').addEventListener('click', () => renderer.zoomIn());
  document.getElementById('btnTreeZoomOut').addEventListener('click', () => renderer.zoomOut());
  document.getElementById('btnTreeFit').addEventListener('click', () => renderer.fit());
  document.getElementById('btnTreeDownload').addEventListener('click', () => {
    if (!currentTree) {
      showToast('There is no tree to download yet.', 'warning');
      return;
    }
    const input = state.run?.input || 'epsilon';
    renderer.downloadSvg(`parse-tree-${input.replace(/[^a-z0-9]/gi, '_')}.svg`);
  });

  for (const button of els.grammarChoice.querySelectorAll('[data-tree-grammar]')) {
    button.addEventListener('click', () => {
      preferredTreeGrammar = button.dataset.treeGrammar;
      render();
    });
  }

  events.addEventListener('parse-computed', render);
  events.addEventListener('grammar-changed', render);
  events.addEventListener('grammar-loaded', render);
  events.addEventListener('engine-changed', render);
  events.addEventListener('section-shown', (event) => {
    // fit() depends on the container's size, which is 0 while hidden —
    // refit when the section becomes visible.
    if (event.detail?.name === 'tree' && currentTree) renderer.fit();
  });

  render();
}

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Show a placeholder message instead of a tree and hide the derivation card.
 *
 * ESCAPING DISCIPLINE: `message` is interpolated as HTML on purpose (the
 * callers embed <strong>/<em> emphasis) — so every DYNAMIC value inside a
 * message passed here MUST already be escapeHtml()'d by the caller. Both
 * current call sites do this; keep it that way when adding messages.
 *
 * @param {string} message Trusted HTML fragment (see note above).
 */
function emptyState(message) {
  currentTree = null;
  els.canvas.innerHTML = `<p class="text-secondary mb-0 p-4">${message}</p>`;
  els.canvas.classList.add('d-flex');
  els.meta.textContent = '';
  els.derivationCard.classList.add('d-none');
}

/**
 * Decide which tree to build for a run, and describe it.
 *
 * A compare run carries both engines' results, so both trees exist and the
 * header toggle picks between them; a single-engine run has only one.
 *
 * @param {object} run The run record from engines.js.
 * @returns {{tree: object, grammar: object, footer: string}|null}
 */
function treeForRun(run) {
  const hasEarley = run.earley !== null && run.earley.result.accepted;
  const hasCyk = run.cyk !== null && run.cyk.result.accepted;

  const wantsCnf = preferredTreeGrammar === 'cnf';
  const useEarley = hasEarley && !(wantsCnf && hasCyk);

  if (useEarley) {
    return {
      tree: buildEarleyTree(run.earley.result),
      // Earley parses the grammar as written, so the tree is labelled with
      // the symbols the user declared.
      grammar: state.grammar,
      footer:
        'derivation tree of your original grammar — every symbol is one you declared',
    };
  }
  if (hasCyk) {
    return {
      tree: buildParseTree(run.cyk.result),
      grammar: run.cyk.grammar,
      footer:
        'derivation tree of the CNF grammar — symbols such as X1 were introduced ' +
        'by the conversion, not by you',
    };
  }
  return null;
}

/** Show the original/CNF toggle only when a run really produced both trees. */
function renderGrammarChoice(run) {
  const both =
    run !== null &&
    run.earley !== null &&
    run.cyk !== null &&
    run.earley.result.accepted &&
    run.cyk.result.accepted;

  els.grammarChoice.classList.toggle('d-none', !both);
  if (!both) return;

  for (const button of els.grammarChoice.querySelectorAll('[data-tree-grammar]')) {
    button.classList.toggle('active', button.dataset.treeGrammar === preferredTreeGrammar);
  }
}

/**
 * Three-state render: no run yet / run rejected (no tree exists by
 * definition) / accepted — build the tree for the engine that ran, draw it,
 * and show the metadata footer + leftmost derivation.
 */
function render() {
  const run = state.run;
  renderGrammarChoice(run);

  if (!run) {
    emptyState(
      'Run the simulator first — the parse tree of an <strong>accepted</strong> string appears here.'
    );
    return;
  }

  if (!run.accepted) {
    emptyState(
      `“${escapeHtml(run.input || EPSILON)}” was <strong>rejected</strong>, so it has no parse tree. ` +
        'Try an accepted string in the simulator.'
    );
    return;
  }

  const chosen = treeForRun(run);
  if (chosen === null) {
    emptyState('This run produced no parse tree.');
    return;
  }

  currentTree = chosen.tree;
  els.canvas.classList.remove('d-flex');
  renderer.render(currentTree);

  const shownInput = run.input === '' ? EPSILON : run.input;
  els.meta.innerHTML =
    `Tree for “<span class="grammar-text">${escapeHtml(shownInput)}</span>” · ` +
    `${countNodes(currentTree)} nodes · depth ${treeDepth(currentTree)} · ` +
    `${chosen.footer} · drag to pan, scroll to zoom`;

  renderDerivation(currentTree, chosen.grammar);
}

/**
 * The leftmost derivation as a sequence of sentential forms.
 *
 * @param {object} tree    The tree being displayed.
 * @param {object} grammar The grammar that tree is labelled with — the
 *        original for an Earley tree, the CNF conversion for a CYK one.
 *        Passed explicitly because it decides which symbols read as
 *        variables, and the two grammars disagree about exactly that.
 */
function renderDerivation(tree, grammar) {
  const forms = leftmostDerivation(tree);
  const variables = new Set(grammar.variables);

  const formHtml = (form) =>
    form.length === 0
      ? `<span class="sym">${EPSILON}</span>`
      : form
          .map((symbol) =>
            variables.has(symbol)
              ? `<span class="sym sym-variable">${escapeHtml(symbol)}</span>`
              : `<span class="sym sym-terminal">${escapeHtml(symbol)}</span>`
          )
          .join('');

  els.derivation.innerHTML = `
    <div class="grammar-display derivation-flow">
      ${forms.map(formHtml).join('<span class="arrow derivation-arrow">⇒</span>')}
    </div>
    <p class="small text-secondary mb-0 mt-2">
      ${forms.length - 1} derivation steps — at every step the <em>leftmost</em> variable is expanded.
    </p>`;
  els.derivationCard.classList.remove('d-none');
}
