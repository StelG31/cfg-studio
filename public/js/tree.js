/**
 * public/js/tree.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Parse-tree visualisation: tidy layout + SVG rendering + interaction
 *   (pan, wheel-zoom around the cursor, zoom buttons, fit-to-view) and a
 *   standalone SVG export. Hand-rolled on plain SVG — no drawing library.
 *
 *   Layout (docs/algorithms.md §6): the classic simplification of
 *   Reingold–Tilford for trees whose leaves are ordered — a post-order
 *   pass gives every leaf the next free horizontal slot and centres every
 *   internal node over its children. O(n), crossing-free.
 *
 *   Colours are written as SVG attributes (not CSS classes) so that the
 *   exported file renders identically outside the application.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* Geometry constants (SVG user units). */
const SLOT_WIDTH = 72;   // horizontal distance between adjacent leaves
const LEVEL_HEIGHT = 84; // vertical distance between depths
const NODE_HEIGHT = 30;
const PADDING = 40;      // white space around the tree

/* Node palette — mirrors the app's variable/terminal colours. */
const STYLE = {
  variable: { fill: '#eef2fa', stroke: '#3d5a99', text: '#3d5a99' },
  terminal: { fill: '#e8f5f3', stroke: '#0f766e', text: '#0f766e' },
  epsilon: { fill: '#f4f5f7', stroke: '#9aa3af', text: '#6b7280' },
  edge: '#b6bec9',
};

/* ------------------------------------------------------------------------ */
/* Layout                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Assign x/y positions. Returns flat lists the renderer consumes.
 * @returns {{nodes: {node,x,y}[], edges: {x1,y1,x2,y2}[], width, height}}
 */
function layoutTree(root) {
  const placed = [];
  const edges = [];
  let nextSlot = 0;

  function place(node, depth) {
    const isLeaf = !node.children || node.children.length === 0;
    let x;
    if (isLeaf) {
      x = nextSlot * SLOT_WIDTH;
      nextSlot += 1;
    } else {
      const childPositions = node.children.map((child) => place(child, depth + 1));
      x = (childPositions[0].x + childPositions.at(-1).x) / 2; // centre over children
      for (const childPosition of childPositions) {
        edges.push({
          x1: x,
          y1: depth * LEVEL_HEIGHT + NODE_HEIGHT / 2,
          x2: childPosition.x,
          y2: (depth + 1) * LEVEL_HEIGHT - NODE_HEIGHT / 2,
        });
      }
    }
    const position = { node, x, y: depth * LEVEL_HEIGHT };
    placed.push(position);
    return position;
  }

  place(root, 0);

  const xs = placed.map((p) => p.x);
  const ys = placed.map((p) => p.y);
  return {
    nodes: placed,
    edges,
    minX: Math.min(...xs),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys),
  };
}

/* ------------------------------------------------------------------------ */
/* Renderer with pan/zoom                                                    */
/* ------------------------------------------------------------------------ */

export class TreeRenderer {
  /** @param {HTMLElement} container The element that will host the SVG. */
  constructor(container) {
    this.container = container;
    this.svg = null;
    this.contentBox = null; // {x, y, w, h} of the drawn tree
  }

  /** Draw `tree` (a core/parser.js node) from scratch. */
  render(tree) {
    this.container.innerHTML = '';

    const { nodes, edges, minX, width, height } = layoutTree(tree);

    this.contentBox = {
      x: minX - PADDING,
      y: -PADDING,
      w: width + 2 * PADDING,
      h: height + NODE_HEIGHT + 2 * PADDING,
    };

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Parse tree');
    this.svg = svg;

    // Edges first (under the nodes).
    for (const edge of edges) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', edge.x1);
      line.setAttribute('y1', edge.y1);
      line.setAttribute('x2', edge.x2);
      line.setAttribute('y2', edge.y2);
      line.setAttribute('stroke', STYLE.edge);
      line.setAttribute('stroke-width', '1.5');
      svg.appendChild(line);
    }

    for (const { node, x, y } of nodes) {
      svg.appendChild(this.#nodeGroup(node, x, y));
    }

    this.container.appendChild(svg);
    this.fit();
    this.#wireInteraction();
  }

  #nodeGroup(node, x, y) {
    const kind = node.epsilon ? 'epsilon' : node.terminal ? 'terminal' : 'variable';
    const style = STYLE[kind];
    const label = node.symbol;
    const boxWidth = Math.max(NODE_HEIGHT + 6, label.length * 10 + 18);

    const group = document.createElementNS(SVG_NS, 'g');

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', x - boxWidth / 2);
    rect.setAttribute('y', y - NODE_HEIGHT / 2);
    rect.setAttribute('width', boxWidth);
    rect.setAttribute('height', NODE_HEIGHT);
    rect.setAttribute('rx', node.terminal ? NODE_HEIGHT / 2 : 7); // pills for leaves
    rect.setAttribute('fill', style.fill);
    rect.setAttribute('stroke', style.stroke);
    rect.setAttribute('stroke-width', '1.4');
    group.appendChild(rect);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', y + 5);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', style.text);
    text.setAttribute(
      'font-family',
      "'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace"
    );
    text.setAttribute('font-size', '15');
    if (node.epsilon) text.setAttribute('font-style', 'italic');
    text.textContent = label;
    group.appendChild(text);

    // Native tooltip: which substring does this node span?
    if (!node.terminal && node.span) {
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${node.symbol} derives positions ${node.span.i + 1}…${
        node.span.i + node.span.l
      }`;
      group.appendChild(title);
    }

    return group;
  }

  /* ——— viewBox helpers ——————————————————————————————————————— */

  #getViewBox() {
    const [x, y, w, h] = this.svg.getAttribute('viewBox').split(' ').map(Number);
    return { x, y, w, h };
  }

  #setViewBox({ x, y, w, h }) {
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }

  /** Convert a mouse event position into SVG user coordinates. */
  #toSvgPoint(event) {
    const rect = this.svg.getBoundingClientRect();
    const viewBox = this.#getViewBox();
    return {
      x: viewBox.x + ((event.clientX - rect.left) / rect.width) * viewBox.w,
      y: viewBox.y + ((event.clientY - rect.top) / rect.height) * viewBox.h,
    };
  }

  /** Zoom by `factor` keeping `pivot` (SVG coords) fixed on screen. */
  #zoomAround(pivot, factor) {
    const viewBox = this.#getViewBox();
    const w = viewBox.w / factor;
    const h = viewBox.h / factor;
    this.#setViewBox({
      x: pivot.x - (pivot.x - viewBox.x) / factor,
      y: pivot.y - (pivot.y - viewBox.y) / factor,
      w,
      h,
    });
  }

  zoomIn() {
    const viewBox = this.#getViewBox();
    this.#zoomAround({ x: viewBox.x + viewBox.w / 2, y: viewBox.y + viewBox.h / 2 }, 1.25);
  }

  zoomOut() {
    const viewBox = this.#getViewBox();
    this.#zoomAround({ x: viewBox.x + viewBox.w / 2, y: viewBox.y + viewBox.h / 2 }, 1 / 1.25);
  }

  /** Reset the viewBox so the whole tree is visible, preserving aspect. */
  fit() {
    if (!this.svg || !this.contentBox) return;
    const { x, y, w, h } = this.contentBox;

    // While the section is hidden the container measures 0×0 — fall back
    // to the raw content box; the view refits when the section is shown.
    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) {
      this.#setViewBox({ x, y, w, h });
      return;
    }

    const aspect = this.container.clientWidth / this.container.clientHeight;
    let viewW = w;
    let viewH = h;
    if (viewW / viewH < aspect) viewW = viewH * aspect;
    else viewH = viewW / aspect;
    this.#setViewBox({ x: x - (viewW - w) / 2, y: y - (viewH - h) / 2, w: viewW, h: viewH });
  }

  /* ——— interaction ——————————————————————————————————————————— */

  #wireInteraction() {
    const svg = this.svg;
    let dragging = null;

    svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.#zoomAround(this.#toSvgPoint(event), event.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    svg.addEventListener('pointerdown', (event) => {
      dragging = { start: this.#toSvgPoint(event), viewBox: this.#getViewBox() };
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
    });

    svg.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      // Recompute the pointer position against the ORIGINAL viewBox so the
      // drag stays anchored to the point initially grabbed.
      const rect = svg.getBoundingClientRect();
      const current = {
        x: dragging.viewBox.x + ((event.clientX - rect.left) / rect.width) * dragging.viewBox.w,
        y: dragging.viewBox.y + ((event.clientY - rect.top) / rect.height) * dragging.viewBox.h,
      };
      this.#setViewBox({
        ...dragging.viewBox,
        x: dragging.viewBox.x - (current.x - dragging.start.x),
        y: dragging.viewBox.y - (current.y - dragging.start.y),
      });
    });

    const endDrag = () => {
      dragging = null;
      svg.style.cursor = 'grab';
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.style.cursor = 'grab';
  }

  /* ——— export ————————————————————————————————————————————————— */

  /** Download the current tree as a standalone .svg file. */
  downloadSvg(fileName = 'parse-tree.svg') {
    if (!this.svg) return;
    const clone = this.svg.cloneNode(true);
    // Freeze the export to the full tree, not the current pan/zoom state.
    const { x, y, w, h } = this.contentBox;
    clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);

    const blob = new Blob(
      ['<?xml version="1.0" encoding="UTF-8"?>\n', clone.outerHTML],
      { type: 'image/svg+xml' }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
