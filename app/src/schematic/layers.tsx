// SVG layers of the schematic canvas. Static layers are memoized on the schematic objects; the live layer
// re-renders at the snapshot rate but only the parts whose visual state changed.
import { memo, useMemo } from 'react';
import {
  activeLayers, componentBounds, ISIS_COLORS, LED_COLORS, isLedColor, pinKey, symbolFor, transformPoint,
  type BuiltNetlist, type ComponentInstance, type ComponentVisual, type Point, type Schematic, type SessionSnapshot, type Wire,
} from '@pic/circuit';
import { useApp } from '../state/store';
import { draftRoute, type PartSpec, type Selection } from './editing';
import { useEditor } from './editorStore';
import { ComponentView, placedPrimitives } from './SymbolGraphic';
import { gridStep, visibleWorld, type View } from './viewport';

// ------------------------------------------------------------------------------------------------ grid

export const GridLayer = memo(function GridLayer({ view, w, h }: { view: View; w: number; h: number }) {
  const step = gridStep(view.k);
  const dot = Math.min(0.2 * step, 1.5 / view.k);
  const r = visibleWorld(view, w, h);
  return (
    <>
      <defs>
        <pattern id="sch-grid" x={-dot / 2} y={-dot / 2} width={step} height={step} patternUnits="userSpaceOnUse">
          <rect width={dot} height={dot} fill={ISIS_COLORS.grid} />
        </pattern>
      </defs>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={ISIS_COLORS.background} />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="url(#sch-grid)" />
    </>
  );
});

// ------------------------------------------------------------------------------------------------ wires

const pointsAttr = (pts: readonly Point[]): string => pts.map((p) => `${p.x},${p.y}`).join(' ');

const WireView = memo(function WireView({ wire }: { wire: Wire }) {
  return <polyline className="sch-wire" points={pointsAttr(wire.points)} stroke={ISIS_COLORS.wire} fill="none" />;
});

export const WiresLayer = memo(function WiresLayer({ wires }: { wires: readonly Wire[] }) {
  return <g>{wires.map((w) => <WireView key={w.id} wire={w} />)}</g>;
});

export const JunctionsLayer = memo(function JunctionsLayer({ points }: { points: readonly Point[] }) {
  return <g>{points.map((p) => <circle key={`${p.x},${p.y}`} cx={p.x} cy={p.y} r={0.22} fill={ISIS_COLORS.wire} />)}</g>;
});

export const DanglingLayer = memo(function DanglingLayer({ points }: { points: readonly Point[] }) {
  if (points.length === 0) return null;
  return (
    <g className="sch-dangling">
      {points.map((p) => (
        <g key={`${p.x},${p.y}`} transform={`translate(${p.x} ${p.y})`}>
          <title>Fil non connecté : cette extrémité ne touche aucune broche ni aucun fil</title>
          <circle r={0.45} />
          <path d="M0 -0.22V0.06M0 0.2V0.22" />
        </g>
      ))}
    </g>
  );
});

// ------------------------------------------------------------------------------------------------ components

export const ComponentsLayer = memo(function ComponentsLayer({ components, rest }: { components: readonly ComponentInstance[]; rest: boolean }) {
  return <g>{components.map((c) => <ComponentView key={c.id} component={c} rest={rest} />)}</g>;
});

// ------------------------------------------------------------------------------------------------ live overlay

function sameVisual(a: ComponentVisual, b: ComponentVisual): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'LED': {
      const o = b as typeof a;
      return o.lit === a.lit && Math.round(o.brightness * 7) === Math.round(a.brightness * 7);
    }
    case '7SEG-BCD': return (b as typeof a).value === a.value;
    case '7SEG-CC': return (b as typeof a).segments === a.segments;
    case 'TRAFFIC_LIGHTS': {
      const o = b as typeof a;
      return o.red === a.red && o.amber === a.amber && o.green === a.green;
    }
    case 'LOGICSTATE': return (b as typeof a).state === a.state;
    case 'BUTTON': return (b as typeof a).pressed === a.pressed;
    case 'TORCH_LDR': return (b as typeof a).level === a.level;
    case 'NONE': return true;
  }
}

const LiveComponent = memo(function LiveComponent({ component, visual }: { component: ComponentInstance; visual: ComponentVisual }) {
  const symbol = symbolFor(component);
  const layers = activeLayers(component, visual);
  const glow = visual.kind === 'LED' && visual.brightness > 0.05 ? visual.brightness : 0;
  const color = isLedColor(component.props.color) ? LED_COLORS[component.props.color].on : LED_COLORS.RED.on;
  const center = glow > 0 ? transformPoint({ x: 0, y: 0 }, component) : null;
  return (
    <g data-live={component.id}>
      {center && <circle cx={center.x} cy={center.y} r={2.2} fill={color} opacity={0.45 * glow} filter="url(#sch-glow)" />}
      {layers.map((l) => <g key={l.name}>{placedPrimitives(symbol.layers[l.name] ?? [], component, l.name, l.opacity)}</g>)}
    </g>
  );
}, (a, b) => a.component === b.component && sameVisual(a.visual, b.visual));

type Level = SessionSnapshot['nets'][string];

function levelColor(level: Level | undefined): string {
  return level === 1 ? ISIS_COLORS.pinHigh : level === 0 ? ISIS_COLORS.pinLow : level === 'X' ? ISIS_COLORS.pinContention : ISIS_COLORS.pinFloating;
}

const NetMarkers = memo(function NetMarkers({ d, level }: { d: string; level: Level | undefined }) {
  return <path d={d} fill={levelColor(level)} />;
});

/** Pin-state squares grouped by net: one path per net, repainted only when its level changes. */
function useMarkerPaths(schematic: Schematic, netlist: BuiltNetlist): [string, string][] {
  return useMemo(() => {
    const byNet = new Map<string, string[]>();
    for (const c of schematic.components) {
      if (c.kind === 'POWER' || c.kind === 'GROUND') continue;
      for (const pin of symbolFor(c).pins) {
        if (pin.hidden) continue;
        const net = netlist.pinToNet.get(pinKey(c.id, pin.name));
        if (!net) continue;
        const m = transformPoint(pin.marker, c);
        const list = byNet.get(net) ?? [];
        list.push(`M${m.x - 0.2} ${m.y - 0.2}h0.4v0.4h-0.4z`);
        byNet.set(net, list);
      }
    }
    return [...byNet.entries()].map(([net, parts]) => [net, parts.join('')]);
  }, [schematic, netlist]);
}

export const LiveLayer = memo(function LiveLayer({ schematic, netlist }: { schematic: Schematic; netlist: BuiltNetlist }) {
  const snapshot = useApp((s) => s.sim.snapshot);
  const markers = useMarkerPaths(schematic, netlist);
  if (!snapshot) return null;
  return (
    <g className="sch-live">
      {schematic.components.map((c) => {
        const v = snapshot.visuals[c.id];
        return v ? <LiveComponent key={c.id} component={c} visual={v} /> : null;
      })}
      {markers.map(([net, d]) => <NetMarkers key={net} d={d} level={snapshot.nets[net]} />)}
    </g>
  );
});

// ------------------------------------------------------------------------------------------------ editing overlays

export const SelectionLayer = memo(function SelectionLayer({ schematic, selection }: { schematic: Schematic; selection: Selection }) {
  if (selection.components.length === 0 && selection.wires.length === 0) return null;
  const ids = new Set(selection.components);
  const wires = new Set(selection.wires);
  return (
    <g className="sch-selection">
      {schematic.wires.filter((w) => wires.has(w.id)).map((w) => (
        <polyline key={w.id} points={pointsAttr(w.points)} className="sch-selected-wire" />
      ))}
      {schematic.components.filter((c) => ids.has(c.id)).map((c) => {
        const b = componentBounds(c);
        const pad = 0.5;
        return <rect key={c.id} x={b.x - pad} y={b.y - pad} width={b.w + 2 * pad} height={b.h + 2 * pad} rx={0.4} className="sch-selected-part" />;
      })}
    </g>
  );
});

export function WireDraftLayer() {
  const draft = useEditor((s) => s.wireDraft);
  if (!draft) return null;
  const route = draftRoute(draft, draft.cursor);
  const pts = [...draft.points, ...route.slice(1)];
  return (
    <g className="sch-draft">
      <polyline points={pointsAttr(pts)} />
      {draft.points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={0.18} />)}
    </g>
  );
}

export function HoverLayer() {
  const p = useEditor((s) => s.hoverPoint);
  if (!p) return null;
  return <circle className="sch-hover-point" cx={p.x} cy={p.y} r={0.45} />;
}

export function MarqueeLayer() {
  const r = useEditor((s) => s.marquee);
  if (!r) return null;
  return <rect className="sch-marquee" x={r.x} y={r.y} width={r.w} height={r.h} />;
}

export function GhostLayer({ schematicHasPic }: { schematicHasPic: boolean }) {
  const placing = useEditor((s) => s.placing);
  const at = useEditor((s) => s.ghostAt);
  const component = useMemo(() => (placing && at ? ghostComponent(placing, at) : null), [placing, at]);
  if (!component) return null;
  const refused = component.kind === 'PIC16F84A' && schematicHasPic;
  return <g className={`sch-ghost${refused ? ' is-refused' : ''}`}><ComponentView component={component} placeholders={false} /></g>;
}

function ghostComponent(spec: PartSpec, at: Point): ComponentInstance {
  const symbol = symbolFor({ kind: spec.kind, props: spec.props ?? {} });
  const c: ComponentInstance = {
    id: '__ghost__', kind: spec.kind, ref: '', at, rotation: spec.rotation ?? 0,
    props: { ...symbol.defaultProps, ...spec.props },
  };
  const value = spec.value ?? symbol.defaultValue;
  if (value) c.value = value;
  if (spec.mirror) c.mirror = true;
  return c;
}

