/**
 * public/js/views/tree-view.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   The Parse Tree section: builds the derivation tree of the last ACCEPTED
 *   CYK run (core/parser.js), renders it with the interactive SVG renderer
 *   (tree.js), and shows the leftmost derivation the tree encodes.
 *
 *   State handling: listens for 'cyk-computed' and re-renders; edits to the
 *   grammar invalidate everything (app.js clears state.cyk) and the section
 *   falls back to its empty state.
 *
 * DOM contract (views/index.html):
 *   #treeCanvas #treeMeta #treeDerivationCard #treeDerivation
 *   #btnTreeZoomIn #btnTreeZoomOut #btnTreeFit #btnTreeDownload
 */

import { EPSILON } from '/core/grammar.js';
import { buildParseTree, leftmostDerivation, countNodes, treeDepth } from '/core/parser.js';
import { state, events } from '../app.js';
import { escapeHtml, showToast } from '../ui.js';
import { TreeRenderer } from '../tree.js';

const els = {};
let renderer = null;
let currentTree = null;

export function init() {
  els.canvas = document.getElementById('treeCanvas');
  els.meta = document.getElementById('treeMeta');
  els.derivationCard = document.getElementById('treeDerivationCard');
  els.derivation = document.getElementById('treeDerivation');

  renderer = new TreeRenderer(els.canvas);

  document.getElementById('btnTreeZoomIn').addEventListener('click', () => renderer.zoomIn());
  document.getElementById('btnTreeZoomOut').addEventListener('click', () => renderer.zoomOut());
  document.getElementById('btnTreeFit').addEventListener('click', () => renderer.fit());
  document.getElementById('btnTreeDownload').addEventListener('click', () => {
    if (!currentTree) {
      showToast('There is no tree to download yet.', 'warning');
      return;
    }
    const input = state.cyk?.input || 'epsilon';
    renderer.downloadSvg(`parse-tree-${input.replace(/[^a-z0-9]/gi, '_')}.svg`);
  });

  events.addEventListener('cyk-computed', render);
  events.addEventListener('grammar-changed', render);
  events.addEventListener('grammar-loaded', render);
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

function emptyState(message) {
  currentTree = null;
  els.canvas.innerHTML = `<p class="text-secondary mb-0 p-4">${message}</p>`;
  els.canvas.classList.add('d-flex');
  els.meta.textContent = '';
  els.derivationCard.classList.add('d-none');
}

function render() {
  const run = state.cyk;

  if (!run) {
    emptyState(
      'Run a CYK simulation first — the parse tree of an <strong>accepted</strong> string appears here.'
    );
    return;
  }

  if (!run.result.accepted) {
    emptyState(
      `“${escapeHtml(run.input || EPSILON)}” was <strong>rejected</strong>, so it has no parse tree. ` +
        'Try an accepted string in the CYK simulator.'
    );
    return;
  }

  currentTree = buildParseTree(run.result);
  els.canvas.classList.remove('d-flex');
  renderer.render(currentTree);

  const shownInput = run.input === '' ? EPSILON : run.input;
  els.meta.innerHTML =
    `Tree for “<span class="grammar-text">${escapeHtml(shownInput)}</span>” · ` +
    `${countNodes(currentTree)} nodes · depth ${treeDepth(currentTree)} · ` +
    'derivation tree of the CNF grammar · drag to pan, scroll to zoom';

  renderDerivation(currentTree, run);
}

/** The leftmost derivation as a sequence of sentential forms. */
function renderDerivation(tree, run) {
  const forms = leftmostDerivation(tree);
  const variables = new Set(run.grammar.variables);

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
