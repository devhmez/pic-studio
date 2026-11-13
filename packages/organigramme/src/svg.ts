// Diagram → standalone SVG string: inline presentation attributes only (no CSS, no external resources), white
// background, embedded arrowhead marker. Deterministic (same diagram → same bytes), so it snapshots well and
// exports as-is (.svg, or drawn on a canvas for PNG / PDF).
import { FONTS, METRICS as M, PALETTES, type Palette } from './theme';
import type { Diagram, DiagramEdge, DiagramLabel, DiagramNode, DiagramStyle, Point, SvgOptions, TextLine } from './types';

const fmt = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Escape for text content and double-quoted attribute values. */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_') || 'org';

function textAttrs(fontKey: DiagramLabel['font'], fill: string, line?: TextLine): string {
  const f = FONTS[fontKey];
  const bold = line?.bold || f.bold;
  return `font-family="${esc(f.family)}" font-size="${fmt(f.size)}"${bold ? ' font-weight="bold"' : ''}`
    + `${f.italic ? ' font-style="italic"' : ''} fill="${fill}"`;
}

/** Centred lines inside a shape; `cx` is the text centre, the block is centred vertically on `cy`. */
function centredLines(lines: readonly TextLine[], fontKey: DiagramNode['font'], cx: number, cy: number, pal: Palette, color: string): string[] {
  const f = FONTS[fontKey];
  const top = cy - (lines.length * f.lineHeight) / 2;
  return lines.map((l, i) => {
    const baseline = top + i * f.lineHeight + f.lineHeight / 2 + f.size * 0.35;
    const fill = l.emphasis === 'off' ? pal.offText : color;
    return `<text x="${fmt(cx)}" y="${fmt(baseline)}" text-anchor="middle" ${textAttrs(fontKey, fill, l)}>${esc(l.text)}</text>`;
  });
}

function labelSvg(l: DiagramLabel, pal: Palette): string {
  return `<text x="${fmt(l.x)}" y="${fmt(l.y)}" text-anchor="${l.anchor}" ${textAttrs(l.font, pal.text)}>${esc(l.text)}</text>`;
}

function nodeSvg(n: DiagramNode, layoutStyle: DiagramStyle, pal: Palette, highlighted: boolean): string {
  const { x, y, w, h } = n.box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const parts: string[] = [];
  switch (n.shape) {
    case 'process':
    case 'subroutine': {
      const paint = pal.box[n.role ?? 'action'];
      parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="${paint.fill}" stroke="${paint.stroke}" stroke-width="${fmt(paint.strokeWidth)}"/>`);
      if (n.shape === 'subroutine') {
        const b = M.subroutineBar;
        parts.push(`<path d="M${fmt(x + b)},${fmt(y)} V${fmt(y + h)} M${fmt(x + w - b)},${fmt(y)} V${fmt(y + h)}" fill="none" stroke="${paint.stroke}" stroke-width="${fmt(paint.strokeWidth)}"/>`);
      }
      parts.push(...centredLines(n.lines, n.font, cx, cy, pal, pal.text));
      break;
    }
    case 'decision': {
      const d = pal.decision;
      parts.push(`<polygon points="${fmt(cx)},${fmt(y)} ${fmt(x + w)},${fmt(cy)} ${fmt(cx)},${fmt(y + h)} ${fmt(x)},${fmt(cy)}" fill="${d.fill}" stroke="${d.stroke}" stroke-width="${fmt(d.strokeWidth)}" stroke-linejoin="miter"/>`);
      parts.push(...centredLines(n.lines, n.font, cx, cy, pal, d.text));
      break;
    }
    case 'start':
    case 'end': {
      const t = pal.terminal;
      if (layoutStyle === 'bw') {
        parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(h / 2)}" ry="${fmt(h / 2)}" fill="${t.fill}" stroke="${t.stroke}" stroke-width="${fmt(t.strokeWidth)}"/>`);
        parts.push(...centredLines(n.lines, n.font, cx, cy, pal, pal.text));
      } else if (n.shape === 'start') {
        // Hollow circle (her Début glyph); the arrow below it is the first edge.
        parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(w / 2)}" fill="${t.fill}" stroke="${t.stroke}" stroke-width="${fmt(t.strokeWidth)}"/>`);
      } else {
        // Bullseye (UML final node): white ring, black disc.
        parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(w / 2 - 0.5)}" fill="${t.fill}" stroke="${t.stroke}" stroke-width="1"/>`);
        parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(M.endInner / 2)}" fill="${t.dot}"/>`);
      }
      if (n.label) parts.push(labelSvg(n.label, pal));
      break;
    }
    case 'tag': {
      // « Boucle infinie » callout: a rectangle with a wedge whose tip touches the loop's return line.
      const g = pal.tag;
      const body = w - M.tagTip;
      const d = `M${fmt(x)},${fmt(y)} H${fmt(x + body)} V${fmt(cy - 5)} L${fmt(x + w)},${fmt(cy)} L${fmt(x + body)},${fmt(cy + 5)} V${fmt(y + h)} H${fmt(x)} Z`;
      parts.push(`<path d="${d}" fill="${g.fill}" stroke="${g.stroke}" stroke-width="${fmt(g.strokeWidth)}" stroke-linejoin="miter"/>`);
      parts.push(...centredLines(n.lines, n.font, x + body / 2, cy, pal, g.text));
      break;
    }
    case 'title': {
      const f = FONTS.title;
      const baseline = y + f.lineHeight / 2 + f.size * 0.35;
      parts.push(`<text x="${fmt(x)}" y="${fmt(baseline)}" text-anchor="start" ${textAttrs('title', pal.text)}>${esc(n.lines.map((l) => l.text).join(' '))}</text>`);
      break;
    }
    case 'junction':
      return '';
  }
  if (highlighted) parts.push(highlightSvg(n, pal));
  const refs = n.refs.length > 0 ? ` data-refs="${esc(n.refs.join(' '))}"` : '';
  return `<g data-node="${esc(n.id)}"${refs}>${parts.join('')}</g>`;
}

/** Selection ring drawn around a node (app: statement under the cursor / being simulated). */
function highlightSvg(n: DiagramNode, pal: Palette): string {
  const { x, y, w, h } = n.box;
  const pad = 4;
  const attrs = `fill="none" stroke="${pal.highlight}" stroke-width="2.5" stroke-linejoin="round"`;
  if (n.shape === 'decision') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    // Offset the rhombus outward by `pad` along its normals (scale each half-diagonal accordingly).
    const k = Math.hypot(w / 2, h / 2);
    const A = w / 2 + (pad * k) / (h / 2);
    const B = h / 2 + (pad * k) / (w / 2);
    return `<polygon points="${fmt(cx)},${fmt(cy - B)} ${fmt(cx + A)},${fmt(cy)} ${fmt(cx)},${fmt(cy + B)} ${fmt(cx - A)},${fmt(cy)}" ${attrs}/>`;
  }
  return `<rect x="${fmt(x - pad)}" y="${fmt(y - pad)}" width="${fmt(w + 2 * pad)}" height="${fmt(h + 2 * pad)}" rx="3" ry="3" ${attrs}/>`;
}

/**
 * Polyline path; with an arrowhead the line stops half-way into the head (the marker's refX is the head's middle),
 * so the tip lands exactly on the target and the square line end stays hidden under the head.
 */
function edgePath(points: readonly Point[], arrow: boolean): string {
  const pts = points.map((p) => ({ ...p }));
  if (arrow && pts.length >= 2) {
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const cut = Math.min(M.arrowLength / 2, len / 2);
    if (len > 0) {
      b.x -= ((b.x - a.x) / len) * cut;
      b.y -= ((b.y - a.y) / len) * cut;
    }
  }
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)},${fmt(p.y)}`).join(' ');
}

function edgeSvg(e: DiagramEdge, pal: Palette, marker: string): string {
  const head = e.arrow ? ` marker-end="url(#${marker})"` : '';
  return `<path data-edge="${esc(e.id)}" d="${edgePath(e.points, e.arrow)}" fill="none" stroke="${pal.line}" stroke-width="${fmt(pal.lineWidth)}" stroke-linejoin="miter"${head}/>`;
}

/** Draw a placed diagram as a standalone SVG document (no DOM needed). */
export function renderSvg(diagram: Diagram, options: SvgOptions = {}): string {
  const style = options.style ?? diagram.style;
  const pal = PALETTES[style];
  const marker = `${safeId(options.idPrefix ?? 'org')}-arrow`;
  const highlight = new Set(options.highlight ?? []);
  const title = options.ariaLabel ?? diagram.title ?? 'Organigramme';
  const w = fmt(diagram.width);
  const h = fmt(diagram.height);
  const L = M.arrowLength;
  const W = M.arrowWidth;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    `<defs><marker id="${marker}" viewBox="0 0 ${L} ${W}" refX="${fmt(L / 2)}" refY="${fmt(W / 2)}" markerWidth="${L}" markerHeight="${W}" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L${L},${fmt(W / 2)} L0,${W} Z" fill="${pal.line}"/></marker></defs>`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="${pal.background}"/>`,
  ];
  for (const n of diagram.nodes) {
    const svg = nodeSvg(n, diagram.style, pal, n.refs.some((r) => highlight.has(r)));
    if (svg) out.push(svg);
  }
  for (const e of diagram.edges) out.push(edgeSvg(e, pal, marker));
  for (const e of diagram.edges) if (e.label) out.push(labelSvg(e.label, pal));
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}
