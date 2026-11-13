// The C code as a printable, syntax-coloured view: a tokenizer for the MikroC dialect (C keywords, PIC16F84A
// registers and bit selectors, MikroC built-ins), then an HTML table (« Rendu du TP » PDF) or a standalone SVG
// (« Capture du code » PNG). Pure and DOM-free (tested in Node). Colours are the light editor theme, for paper.
import { BUILTINS, isBitSelector, MIKROC_KEYWORDS, SFR_NAMES } from '../code/vocabulary';

export type CodeTokenKind = 'kw' | 'type' | 'comment' | 'num' | 'str' | 'pre' | 'macro' | 'sfr' | 'bit' | 'builtin' | 'plain';

export interface CodeToken {
  text: string;
  kind: CodeTokenKind;
}

/** Light theme of the code editor (CodePanel.css), readable on white paper. */
export const CODE_COLORS: Readonly<Record<Exclude<CodeTokenKind, 'plain'>, { color: string; bold?: boolean; italic?: boolean }>> = {
  kw: { color: '#1e3a8a', bold: true },
  type: { color: '#1e3a8a', bold: true },
  comment: { color: '#2e7d32', italic: true },
  num: { color: '#7e22ce' },
  str: { color: '#a14f05' },
  pre: { color: '#6d28d9', bold: true },
  macro: { color: '#8a4510' },
  sfr: { color: '#0b5f8a', bold: true },
  bit: { color: '#b0185a', bold: true },
  builtin: { color: '#0f766e', bold: true },
};

const C_KEYWORDS = new Set([
  'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'sizeof',
  'typedef', 'struct', 'union', 'enum', 'static', 'extern', 'const', 'volatile', 'register', 'auto',
  ...MIKROC_KEYWORDS.filter((k) => k !== 'at' && k !== 'bit'),
]);
const C_TYPES = new Set(['void', 'char', 'int', 'short', 'long', 'unsigned', 'signed', 'float', 'double', 'bit']);
const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name.toUpperCase()));

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|\d+(?:\.\d+)?)[uUlL]*/y;

/** Tabs to 4-column stops (MikroC's default), so columns line up in the capture. */
export function expandTabs(line: string, width = 4): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(width - (out.length % width));
    else out += ch;
  }
  return out;
}

function classifyWord(word: string, line: string, start: number, afterDefine: boolean): CodeTokenKind {
  let before = start - 1;
  while (before >= 0 && (line[before] === ' ' || line[before] === '\t')) before--;
  if (before >= 0 && line[before] === '.') return isBitSelector(word) ? 'bit' : 'plain';
  if (afterDefine) return 'macro';
  if (C_TYPES.has(word)) return 'type';
  if (C_KEYWORDS.has(word)) return 'kw';
  const upper = word.toUpperCase();
  if (SFR_NAMES.has(upper)) return 'sfr';
  if (BUILTIN_NAMES.has(upper)) return 'builtin';
  if (word === 'at' && /\bsbit\s+[A-Za-z_]\w*\s*$/.test(line.slice(0, start))) return 'kw';
  return 'plain';
}

/** Tokens of every line (a block comment may span several lines). Line breaks: \n, \r\n or \r. */
export function tokenizeC(source: string): CodeToken[][] {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => expandTabs(l));
  const out: CodeToken[][] = [];
  let inBlock = false;
  for (const line of lines) {
    const tokens: CodeToken[] = [];
    const push = (text: string, kind: CodeTokenKind) => {
      if (!text) return;
      const last = tokens[tokens.length - 1];
      if (last && last.kind === kind) last.text += text;
      else tokens.push({ text, kind });
    };
    let i = 0;
    let afterDefine = false;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) {
        push(line, 'comment');
        out.push(tokens);
        continue;
      }
      push(line.slice(0, end + 2), 'comment');
      i = end + 2;
      inBlock = false;
    }
    // Preprocessor directive at the start of the line: `#define`, `#include <htc.h>`.
    const directive = /^(\s*)(#\s*[A-Za-z]+)/.exec(line.slice(i));
    if (directive && i === 0) {
      push(directive[1], 'plain');
      push(directive[2], 'pre');
      i = directive[0].length;
      afterDefine = /define$/.test(directive[2]);
      const include = /^(\s*)(<[^>]*>)/.exec(line.slice(i));
      if (include && /include$/.test(directive[2])) {
        push(include[1], 'plain');
        push(include[2], 'str');
        i += include[0].length;
      }
    }
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '/' && next === '/') {
        push(line.slice(i), 'comment');
        break;
      }
      if (ch === '/' && next === '*') {
        const end = line.indexOf('*/', i + 2);
        if (end < 0) {
          push(line.slice(i), 'comment');
          inBlock = true;
          break;
        }
        push(line.slice(i, end + 2), 'comment');
        i = end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
        push(line.slice(i, Math.min(line.length, j + 1)), 'str');
        i = j + 1;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(line);
        const text = m ? m[0] : ch;
        push(text, 'num');
        i += text.length;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        IDENT.lastIndex = i;
        const word = IDENT.exec(line)![0];
        push(word, classifyWord(word, line, i, afterDefine));
        afterDefine = false;
        i += word.length;
        continue;
      }
      push(ch, 'plain');
      i++;
    }
    out.push(tokens);
  }
  return out;
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** CSS of the classes used by codeToHtml (to put in the page's <style>). */
export function codeCss(): string {
  return Object.entries(CODE_COLORS)
    .map(([k, v]) => `.c-${k} { color: ${v.color};${v.bold ? ' font-weight: 700;' : ''}${v.italic ? ' font-style: italic;' : ''} }`)
    .join('\n');
}

/** The code as an HTML table: one row per line, the line number in its own cell (not copied with the code). */
export function codeToHtml(source: string): string {
  const rows = tokenizeC(source).map((tokens, k) => {
    const html = tokens.map((t) => (t.kind === 'plain' ? escHtml(t.text) : `<span class="c-${t.kind}">${escHtml(t.text)}</span>`)).join('');
    return `<tr><td class="ln">${k + 1}</td><td class="src">${html || ' '}</td></tr>`;
  });
  return `<table class="code"><tbody>\n${rows.join('\n')}\n</tbody></table>`;
}

// ------------------------------------------------------------------------------------------------ SVG capture

export interface CodeSvgOptions {
  /** File name shown in the card's title strip (« tp-status.c »). */
  fileName?: string;
  /** Second, quieter text of the title strip (« PIC16F84A · 1 MHz »). */
  detail?: string;
  /** Font size in CSS pixels (default 13). */
  fontSize?: number;
}

/** Advance of one character of the monospaced font (Menlo / SF Mono / Consolas: 0.6 em). */
const MONO_ADVANCE = 0.602;

/**
 * The code as a standalone SVG card in PIC Studio's look (white page, line numbers, title strip with the file name),
 * ready to rasterize to PNG for Word. Never imitates another program's window.
 */
export function codeToSvg(source: string, options: CodeSvgOptions = {}): string {
  const fs = options.fontSize ?? 13;
  const lineH = Math.round(fs * 1.55);
  const charW = fs * MONO_ADVANCE;
  const lines = tokenizeC(source);
  const longest = Math.max(20, ...lines.map((l) => l.reduce((n, t) => n + t.text.length, 0)));
  const digits = String(lines.length).length;
  const pad = 16;
  const head = options.fileName || options.detail ? 34 : 0;
  const gutter = Math.ceil((digits + 2) * charW);
  const width = Math.ceil(pad * 2 + gutter + 12 + longest * charW);
  const height = Math.ceil(head + pad + lines.length * lineH + pad);
  const font = "Menlo, 'SF Mono', Monaco, Consolas, 'Liberation Mono', monospace";
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escHtml(options.fileName ?? 'Code C')}">`,
    `<defs><clipPath id="code-card"><rect x="0" y="0" width="${width}" height="${height}" rx="8"/></clipPath></defs>`,
    '<g clip-path="url(#code-card)">',
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#FFFFFF"/>`,
    `<rect x="0" y="${head}" width="${pad + gutter}" height="${height - head}" fill="#FAFAF8"/>`,
    `<path d="M${pad + gutter + 0.5} ${head}V${height}" stroke="#ECECE8"/>`,
  ];
  if (head) {
    parts.push(`<rect x="0" y="0" width="${width}" height="${head}" fill="#F4F4F1"/>`);
    parts.push(`<path d="M0 ${head - 0.5}H${width}" stroke="#E2E2DE"/>`);
    const text: string[] = [];
    if (options.fileName) text.push(`<tspan font-weight="600" fill="#1F2328">${escHtml(options.fileName)}</tspan>`);
    if (options.detail) text.push(`<tspan fill="#6B6F76"${options.fileName ? ' dx="12"' : ''}>${escHtml(options.detail)}</tspan>`);
    parts.push(`<text x="${pad}" y="${head / 2}" dominant-baseline="central" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif" font-size="12.5">${text.join('')}</text>`);
  }
  parts.push('</g>');
  parts.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="7.5" fill="none" stroke="#D4D4D0"/>`);
  const top = head + pad;
  parts.push(`<g font-family="${escHtml(font)}" font-size="${fs}" xml:space="preserve">`);
  lines.forEach((tokens, k) => {
    const y = top + k * lineH + lineH / 2;
    parts.push(`<text x="${pad + gutter - charW}" y="${y}" dominant-baseline="central" text-anchor="end" fill="#9A9DA3">${k + 1}</text>`);
    if (tokens.length === 0) return;
    const spans = tokens.map((t) => {
      if (t.kind === 'plain') return `<tspan fill="#1F2328">${escHtml(t.text)}</tspan>`;
      const c = CODE_COLORS[t.kind];
      return `<tspan fill="${c.color}"${c.bold ? ' font-weight="700"' : ''}${c.italic ? ' font-style="italic"' : ''}>${escHtml(t.text)}</tspan>`;
    });
    parts.push(`<text x="${pad + gutter + 12}" y="${y}" dominant-baseline="central" style="white-space:pre">${spans.join('')}</text>`);
  });
  parts.push('</g>', '</svg>', '');
  return parts.join('\n');
}
