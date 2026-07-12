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

import { EPSILON } from '/core/grammar.js';
import { escapeHtml } from './ui.js';

/** One symbol, coloured by kind (indigo variables / teal terminals). */
export function symbolHtml(symbol, grammar) {
  const kind = grammar.variables.includes(symbol) ? 'variable' : 'terminal';
  return `<span class="sym sym-${kind}">${escapeHtml(symbol)}</span>`;
}

/** A right-hand side: coloured symbols separated by thin spaces, or ε. */
export function rhsHtml(right, grammar) {
  if (right.length === 0) return `<span class="sym">${EPSILON}</span>`;
  return right.map((symbol) => symbolHtml(symbol, grammar)).join(' ');
}

/** A single production: A → α. */
export function productionHtml(production, grammar) {
  return (
    `${symbolHtml(production.left, grammar)} ` +
    `<span class="arrow">→</span> ${rhsHtml(production.right, grammar)}`
  );
}

/**
 * A whole grammar in the classic textbook layout: one line per variable,
 * alternatives joined with |, in order of first appearance.
 */
export function grammarHtml(grammar) {
  const byLeft = new Map();
  for (const production of grammar.productions) {
    if (!byLeft.has(production.left)) byLeft.set(production.left, []);
    byLeft.get(production.left).push(production.right);
  }

  const lines = [...byLeft.entries()].map(([left, alternatives]) => {
    const rhs = alternatives
      .map((right) => rhsHtml(right, grammar))
      .join(' <span class="arrow">|</span> ');
    return `<div>${symbolHtml(left, grammar)} <span class="arrow">→</span> ${rhs}</div>`;
  });

  return `<div class="grammar-display">${
    lines.join('') || '<span class="text-secondary small">no productions</span>'
  }</div>`;
}
