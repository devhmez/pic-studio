/** Disjoint sets over string keys (path halving, union by size). */
export class UnionFind {
  private readonly index = new Map<string, number>();
  private parent: number[] = [];
  private size: number[] = [];

  id(key: string): number {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.parent.length;
      this.index.set(key, i);
      this.parent.push(i);
      this.size.push(1);
    }
    return i;
  }

  find(key: string): number {
    return this.root(this.id(key));
  }

  union(a: string, b: string): void {
    let ra = this.root(this.id(a));
    let rb = this.root(this.id(b));
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
  }

  private root(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]];
      i = p[i];
    }
    return i;
  }
}

/** Disjoint sets over dense integer ids 0..n-1. */
export class IntUnionFind {
  private readonly parent: Int32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]];
      i = p[i];
    }
    return i;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}
