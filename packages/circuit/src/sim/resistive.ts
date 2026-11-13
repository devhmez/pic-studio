// Tiny nodal analysis for resistor networks (pull-ups/downs, series resistors, LDR divider, conducting LEDs).

export interface Conductance {
  a: number;
  b: number;
  /** Siemens (1 / ohms). */
  g: number;
}

/**
 * Node voltages of a resistive network. `fixed[i]` is the imposed voltage of node i (strong driver, rail) or NaN
 * for a free node. `inject[i]` (optional) is a constant current in amperes flowing into free node i (Norton
 * sources, e.g. the forward voltage of a conducting LED). Free nodes with no resistive path to a fixed node come
 * back as NaN (floating).
 */
export function solveResistive(
  nodeCount: number, edges: readonly Conductance[], fixed: Float64Array, inject?: Float64Array,
): Float64Array {
  const v = Float64Array.from(fixed);
  const isFree = (i: number) => Number.isNaN(fixed[i]);

  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  edges.forEach((e, k) => {
    if (e.a === e.b || e.g <= 0) return;
    adjacency[e.a].push(k);
    adjacency[e.b].push(k);
  });

  // Group free nodes connected through free-free resistors; each group is one small linear system.
  const local = new Int32Array(nodeCount).fill(-1);
  for (let start = 0; start < nodeCount; start++) {
    if (!isFree(start) || local[start] >= 0 || adjacency[start].length === 0) continue;
    const group = [start];
    local[start] = 0;
    for (let q = 0; q < group.length; q++) {
      const n = group[q];
      for (const k of adjacency[n]) {
        const m = edges[k].a === n ? edges[k].b : edges[k].a;
        if (isFree(m) && local[m] < 0) { local[m] = group.length; group.push(m); }
      }
    }
    solveGroup(group, local, adjacency, edges, fixed, inject, v);
  }
  return v;
}

function solveGroup(
  group: number[], local: Int32Array, adjacency: number[][], edges: readonly Conductance[],
  fixed: Float64Array, inject: Float64Array | undefined, v: Float64Array,
): void {
  const size = group.length;
  const a = Array.from({ length: size }, () => new Float64Array(size));
  const b = new Float64Array(size);
  let anchored = false;
  group.forEach((n, i) => {
    b[i] = inject?.[n] ?? 0;
    for (const k of adjacency[n]) {
      const e = edges[k];
      const m = e.a === n ? e.b : e.a;
      a[i][i] += e.g;
      if (Number.isNaN(fixed[m])) a[i][local[m]] -= e.g;
      else { b[i] += e.g * fixed[m]; anchored = true; }
    }
  });
  if (!anchored) return; // floating island: stays NaN
  if (size === 1) {
    v[group[0]] = b[0] / a[0][0];
    return;
  }
  const x = gaussianSolve(a, b);
  group.forEach((n, i) => { v[n] = x[i]; });
}

/** Gaussian elimination with partial pivoting (systems here have a handful of unknowns). */
function gaussianSolve(a: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const d = a[col][col];
    if (Math.abs(d) < 1e-30) continue;
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = Math.abs(a[r][r]) < 1e-30 ? NaN : s / a[r][r];
  }
  return x;
}
