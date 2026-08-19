/**
 * public/js/grammar-render.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Shared HTML renderers for grammar notation, used by every view that
 *   displays grammars (editor overview, CNF steps, CYK header, parse tree
 *   legend). Centralising them guarantees that a variable or terminal looks
 *   identical everywhere in the application.
 *
 *   Pure "data → HTML string" functions; no DOM access, no state.
 */

import { EPSILON, productionKey } from '/core/grammar.js';
import { escapeHtml } from './ui.js';

/**
 * One symbol, coloured by kind (indigo variables / teal terminals).
 * Classification is against the GIVEN grammar's variable list — callers
 * rendering an intermediate CNF stage pass that stage's snapshot, so fresh
 * variables like T_a colour correctly the moment they are introduced.
 *
 * @param {string} symbol  The symbol to render (escaped here).
 * @param {object} grammar The grammar whose variable set decides the kind.
 * @returns {string} HTML span.
 */
export function symbolHtml(symbol, grammar) {
  const kind = grammar.variables.includes(symbol) ? 'variable' : 'terminal';
  return `<span class="sym sym-${kind}">${escapeHtml(symbol)}</span>`;
}

/**
 * A right-hand side: coloured symbols separated by thin spaces, or ε for
 * the empty array (the project-wide ε representation).
 *
 * @param {string[]} right  Production right-hand side.
 * @param {object} grammar  Grammar for symbol classification.
 * @returns {string} HTML fragment.
 */
export function rhsHtml(right, grammar) {
  if (right.length === 0) return `<span class="sym">${EPSILON}</span>`;
  return right.map((symbol) => symbolHtml(symbol, grammar)).join(' ');
}

/**
 * A single production: A → α.
 *
 * @param {{left: string, right: string[]}} production
 * @param {object} grammar Grammar for symbol classification.
 * @returns {string} HTML fragment.
 */
export function productionHtml(production, grammar) {
  return (
    `${symbolHtml(production.left, grammar)} ` +
    `<span class="arrow">→</span> ${rhsHtml(production.right, grammar)}`
  );
}

/**
 * A whole grammar in the classic textbook layout: one line per variable,
 * alternatives joined with |, in order of first appearance.
 *
 * With `ruleKeys` each ALTERNATIVE is wrapped in a .cyk-rule span carrying
 * its productionKey, which is what lets an animation flash the single rule a
 * step used. It is opt-in because the wrapper is pure overhead for the views
 * that only display a grammar, and because the textbook layout is worth
 * keeping: the one-production-per-line form the CNF panel uses would make an
 * Earley grammar read quite differently from the same grammar in the editor.
 *
 * @param {object} grammar The grammar to render.
 * @param {{ruleKeys?: boolean}} [options] ruleKeys: tag alternatives for lookup.
 * @returns {string} a .grammar-display div (safe: all symbols escaped).
 */
export function grammarHtml(grammar, { ruleKeys = false } = {}) {
  const byLeft = new Map();
  for (const production of grammar.productions) {
    if (!byLeft.has(production.left)) byLeft.set(production.left, []);
    byLeft.get(production.left).push(production.right);
  }

  const lines = [...byLeft.entries()].map(([left, alternatives]) => {
    const rhs = alternatives
      .map((right) => {
        const html = rhsHtml(right, grammar);
        if (!ruleKeys) return html;
        const key = escapeHtml(productionKey({ left, right }));
        return `<span class="cyk-rule" data-rule-key="${key}">${html}</span>`;
      })
      .join(' <span class="arrow">|</span> ');
    return `<div>${symbolHtml(left, grammar)} <span class="arrow">→</span> ${rhs}</div>`;
  });

  return `<div class="grammar-display">${
    lines.join('') || '<span class="text-secondary small">no productions</span>'
  }</div>`;
}
