// Helpers relating two builds of the same project: identical machine code, C line numbers mapped through the text
// edit between them (a line diff), and program addresses mapped from one build to the other. The store uses them to
// keep breakpoints on their statement while the student types, and the panels to show where the paused core really
// is when the edited code has not been reloaded into the simulator yet.
import type { CompileResultEx } from '@pic/compiler';

// ------------------------------------------------------------------------------------------------ same program

/** True when both builds produce the very same program memory and configuration word. */
export function sameProgram(a: CompileResultEx | null | undefined, b: CompileResultEx | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (!a.ok || !b.ok || !a.program || !b.program || a.config !== b.config) return false;
  if (a.program.length !== b.program.length) return false;
  for (let i = 0; i < a.program.length; i++) if (a.program[i] !== b.program[i]) return false;
  return true;
}

// ------------------------------------------------------------------------------------------------ line map

/** Maps a 1-based line number of the old text to the new text, or null when the line was removed. */
export type LineMap = (line: number) => number | null;

/** Above this many cells the middle of the diff is not aligned (a whole new file was pasted). */
const MAX_DIFF_CELLS = 4_000_000;

const splitLines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());

/**
 * Line map from `from` to `to` through a line diff: unchanged lines follow their content (lines inserted or
 * deleted above shift them), and inside a changed region the old lines are paired in order with the new ones
 * (a line edited in place keeps its identity; surplus old lines are reported as removed).
 */
export function diffLineMap(from: string, to: string): LineMap {
  const a = splitLines(from);
  const b = splitLines(to);
  const map = new Int32Array(a.length).fill(-1);

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    map[pre] = pre;
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    map[a.length - 1 - suf] = b.length - 1 - suf;
    suf++;
  }

  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  // Matched pairs of the middle part (indices relative to the whole texts), in order.
  const pairs: [number, number][] = [];
  if (n > 0 && m > 0 && n * m <= MAX_DIFF_CELLS) {
    // Longest common subsequence, suffix table: lcs[i][j] for a[pre+i..], b[pre+j..].
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[pre + i] === b[pre + j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[pre + i] === b[pre + j]) {
        pairs.push([pre + i, pre + j]);
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
      else j++;
    }
  }
  // Anchors: the matched pairs plus sentinels around the middle; between two anchors the remaining old and new
  // lines form a changed region, paired in order.
  const anchors: [number, number][] = [[pre - 1, pre - 1], ...pairs, [a.length - suf, b.length - suf]];
  for (let k = 0; k < anchors.length - 1; k++) {
    const [ai, bi] = anchors[k];
    const [aj, bj] = anchors[k + 1];
    if (k > 0) map[ai] = bi;
    const oldCount = aj - ai - 1;
    const newCount = bj - bi - 1;
    for (let t = 0; t < Math.min(oldCount, newCount); t++) map[ai + 1 + t] = bi + 1 + t;
  }

  return (line: number) => {
    if (!Number.isInteger(line) || line < 1 || line > a.length) return null;
    const to0 = map[line - 1];
    return to0 < 0 ? null : to0 + 1;
  };
}

const lineMapCache = new WeakMap<CompileResultEx, { to: CompileResultEx; map: LineMap }>();

/** Line map between the sources of two builds (cached for the last target of each build). */
export function buildLineMap(from: CompileResultEx, to: CompileResultEx): LineMap {
  if (from === to || from.source === to.source) return (line) => line;
  const hit = lineMapCache.get(from);
  if (hit && hit.to === to) return hit.map;
  const map = diffLineMap(from.source, to.source);
  lineMapCache.set(from, { to, map });
  return map;
}

// ------------------------------------------------------------------------------------------------ addresses

const addrsByLineCache = new WeakMap<CompileResultEx, Map<number, number[]>>();

/** C line → every program address generated for it, ascending. */
export function addressesByLine(r: CompileResultEx): Map<number, number[]> {
  let out = addrsByLineCache.get(r);
  if (out) return out;
  out = new Map();
  for (const [addr, line] of r.addrToLine) {
    const list = out.get(line);
    if (list) list.push(addr);
    else out.set(line, [addr]);
  }
  for (const list of out.values()) list.sort((x, y) => x - y);
  addrsByLineCache.set(r, out);
  return out;
}

/**
 * Map program addresses of build `from` to build `to`:
 *  - identical machine code: the addresses are kept as they are;
 *  - otherwise each address follows its C statement through the text edit and keeps its rank among the
 *    instructions of that statement (the 2nd instruction of a line stays the 2nd one). Addresses whose statement
 *    was deleted, or no longer generates code, are dropped; addresses outside any C line (startup code) are kept.
 * The result is sorted and duplicate-free; the input array itself is returned when nothing moved.
 */
export function remapAddresses(addrs: readonly number[], from: CompileResultEx, to: CompileResultEx): number[] {
  if (addrs.length === 0 || from === to || sameProgram(from, to)) return addrs as number[];
  if (!from.ok || !to.ok) return addrs as number[];
  const lines = buildLineMap(from, to);
  const fromLines = addressesByLine(from);
  const toLines = addressesByLine(to);
  const out = new Set<number>();
  for (const addr of addrs) {
    const line = from.addrToLine.get(addr);
    if (line === undefined) {
      out.add(addr);
      continue;
    }
    const target = lines(line);
    const candidates = target === null ? undefined : toLines.get(target);
    if (!candidates || candidates.length === 0) continue;
    const rank = Math.max(0, fromLines.get(line)?.indexOf(addr) ?? 0);
    out.add(candidates[Math.min(rank, candidates.length - 1)]);
  }
  const mapped = [...out].sort((x, y) => x - y);
  return mapped.length === addrs.length && mapped.every((v, i) => v === addrs[i]) ? addrs as number[] : mapped;
}

/** Map one C line of build `from` to the numbering of build `to` (null when that line is gone). */
export function mapLine(line: number | null, from: CompileResultEx, to: CompileResultEx): number | null {
  if (line === null) return null;
  return buildLineMap(from, to)(line);
}
