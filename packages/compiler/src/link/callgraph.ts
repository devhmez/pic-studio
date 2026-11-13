import type { CodeUnit } from '../codegen/units';

export type UnitContext = 'main' | 'isr' | 'both' | 'none';

/** Reachability and stack depth over the unit graph (CALL edges cost a stack level, GOTO edges do not). */
export class CallGraph {
  private readonly byName = new Map<string, CodeUnit>();
  private readonly reachCache = new Map<string, Set<string>>();

  constructor(
    readonly units: CodeUnit[],
    readonly resetUnit: string,
    readonly isrUnit: string | undefined,
  ) {
    for (const u of units) this.byName.set(u.name, u);
  }

  unit(name: string): CodeUnit | undefined {
    return this.byName.get(name);
  }

  private edges(u: CodeUnit): string[] {
    return [...u.callees, ...u.jumps].filter((n) => this.byName.has(n));
  }

  /** Units reachable from `name` (inclusive). */
  reach(name: string): Set<string> {
    const cached = this.reachCache.get(name);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [name];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const u = this.byName.get(n);
      if (u) stack.push(...this.edges(u));
    }
    this.reachCache.set(name, seen);
    return seen;
  }

  context(name: string): UnitContext {
    const inMain = this.reach(this.resetUnit).has(name);
    const inIsr = this.isrUnit ? this.reach(this.isrUnit).has(name) : false;
    if (inMain && inIsr) return 'both';
    if (inIsr) return 'isr';
    if (inMain) return 'main';
    return 'none';
  }

  /** Two frames may share RAM only if neither unit can be active while the other one is. */
  conflict(a: string, b: string): boolean {
    if (a === b) return true;
    const ca = this.context(a);
    const cb = this.context(b);
    if (ca === 'both' || cb === 'both') return true;
    if (ca !== cb && ca !== 'none' && cb !== 'none') return true;
    return this.reach(a).has(b) || this.reach(b).has(a);
  }

  /** Stack levels used below `name` (0 for a leaf). Cycles are reported elsewhere and cut here. */
  depth(name: string, visiting = new Set<string>()): number {
    const u = this.byName.get(name);
    if (!u || visiting.has(name)) return 0;
    visiting.add(name);
    let d = 0;
    for (const c of u.callees) if (this.byName.has(c)) d = Math.max(d, 1 + this.depth(c, visiting));
    for (const j of u.jumps) if (this.byName.has(j)) d = Math.max(d, this.depth(j, visiting));
    visiting.delete(name);
    return d;
  }

  /** Callers before callees (reverse post-order from the roots, then the unreachable units). */
  topologicalOrder(): CodeUnit[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (n: string) => {
      if (seen.has(n)) return;
      seen.add(n);
      const u = this.byName.get(n);
      if (u) this.edges(u).forEach(visit);
      order.push(n);
    };
    visit(this.resetUnit);
    if (this.isrUnit) visit(this.isrUnit);
    for (const u of this.units) visit(u.name);
    return order.reverse().map((n) => this.byName.get(n)!).filter(Boolean);
  }
}
