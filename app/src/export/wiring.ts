// « Fiche de câblage »: everything needed to redraw the circuit in ISIS on the lab PC (or in the Windows VM) in a
// couple of minutes: the parts to pick, the settings to type, what each PIC pin connects to and every wire.
// Pure: data model from the schematic + its netlist, then a standalone printable HTML page.
import {
  buildNetlist, isisPartName, symbolFor, type ComponentInstance, type Net, type Netlist, type PinRef, type Schematic,
} from '@pic/circuit';
import { busPins, gpioOfSchematicPin, type Program } from '@pic/program-model';

export interface WiringComponent {
  ref: string;
  /** Proteus library name to type in « Pick Devices » (LED-RED, LOGICSTATE, 7SEG-BCD-BLUE…). */
  part: string;
  value: string;
  /** Properties to set after placing it (CLOCK, PROGRAM, initial state…). */
  settings: string[];
}

export interface WiringPin {
  number: number;
  name: string;
  /** What the program does with the pin (« Sortie LED_SUP — Led supérieur »), when a program is known. */
  role: string;
  /** Plain-French endpoints reached from this pin (one hop through a series resistor). */
  connections: string[];
}

export interface WiringWire {
  title: string;
  ends: string[];
}

export interface WiringSheet {
  title: string;
  clock: string;
  config: string;
  hexFile: string;
  components: WiringComponent[];
  terminals: { power: number; ground: number };
  pins: WiringPin[];
  wires: WiringWire[];
  notes: string[];
}

export interface WiringOptions {
  title: string;
  /** Program whose signals give each pin its role (assistant model or rebuilt from the code). */
  program?: Program | null;
  /** Name of the .hex to load into the PIC (« tp-status.hex »). */
  hexFile: string;
  config?: number;
  clockHz?: number;
}

const refOf = (c: ComponentInstance): string => c.ref?.trim() || c.id;

/** ISIS CLOCK text: 1MHz, 8MHz, 32.768kHz. */
export function clockText(hz: number): string {
  if (hz >= 1e6) return `${Math.round((hz / 1e6) * 1000) / 1000}MHz`;
  if (hz >= 1e3) return `${Math.round((hz / 1e3) * 1000) / 1000}kHz`;
  return `${hz}Hz`;
}

const LAMP_NAMES: Readonly<Record<string, string>> = { R: 'feu rouge (R)', A: 'feu orange (A)', G: 'feu vert (G)' };

/** « D1 (LED-RED) : anode », « R4 (220) : patte 1 », « U1 : broche 6 (RB0/INT) ». */
export function endpointLabel(c: ComponentInstance, pin: string): string {
  const ref = refOf(c);
  const part = isisPartName(c);
  switch (c.kind) {
    case 'PIC16F84A': {
      const number = symbolFor(c).pins.find((p) => p.name === pin)?.number;
      return `${ref} : broche ${number ?? '?'} (${pin})`;
    }
    case 'LED': return `${ref} (${part}) : ${pin === 'A' ? 'anode' : 'cathode'}`;
    case 'RES': return `${ref} (${c.value || 'RES'}) : patte ${pin}`;
    case 'LOGICSTATE': return `${ref} (LOGICSTATE)`;
    case 'BUTTON': return `${ref} (BUTTON) : patte ${pin}`;
    case '7SEG-BCD': return `${ref} (${part}) : entrée ${pin}${pin === 'E0' ? ' (poids faible)' : pin === 'E3' ? ' (poids fort)' : ''}`;
    case '7SEG-CC': return `${ref} (${part}) : ${pin === 'K' ? 'cathode commune' : `segment ${pin}`}`;
    case 'TRAFFIC_LIGHTS': return `${ref} (TRAFFIC LIGHTS) : ${LAMP_NAMES[pin] ?? pin}`;
    case 'TORCH_LDR': return `${ref} (TORCH_LDR) : patte ${pin}`;
    case 'CAP': return `${ref} (CAP ${c.value ?? ''}) : patte ${pin}`.replace('  ', ' ');
    case 'CRYSTAL': return `${ref} (CRYSTAL) : patte ${pin}`;
    case 'POWER': return '+5 V (terminal POWER)';
    case 'GROUND': return 'masse (terminal GROUND)';
  }
}

function settingsOf(c: ComponentInstance, opts: WiringOptions): string[] {
  switch (c.kind) {
    case 'PIC16F84A': {
      const out = [`Program File : ${opts.hexFile}`, `Processor Clock Frequency : ${clockText(opts.clockHz ?? 1_000_000)}`];
      const config = opts.config ?? 0x3ffb;
      if (config !== 0x3ffb) out.push(`Configuration Word : 0x${config.toString(16).toUpperCase().padStart(4, '0')}`);
      return out;
    }
    case 'LOGICSTATE': return [`État de départ : ${Number(c.props.state ?? 0) ? 1 : 0}`];
    case 'TORCH_LDR': return ['Luminosité réglée pendant la simulation (flèches + / −)'];
    default: return [];
  }
}

interface Topo {
  byId: Map<string, ComponentInstance>;
  nets: Map<string, Net>;
  netlist: Netlist;
}

function peersOf(t: Topo, componentId: string, pin: string): PinRef[] {
  const id = t.netlist.pinToNet.get(`${componentId}:${pin}`);
  const net = id ? t.nets.get(id) : undefined;
  return net ? net.pins.filter((p) => !(p.componentId === componentId && p.pin === pin)) : [];
}

function railOf(t: Topo, componentId: string, pin: string): 'VDD' | 'GND' | undefined {
  const id = t.netlist.pinToNet.get(`${componentId}:${pin}`);
  return id ? t.nets.get(id)?.rail : undefined;
}

/** Endpoints of a PIC pin: direct neighbours, and what sits behind a series resistor. */
function pinConnections(t: Topo, picId: string, pin: string): string[] {
  const rail = railOf(t, picId, pin);
  if (rail === 'GND') return ['reliée directement à la masse'];
  if (rail === 'VDD') return ['reliée directement au +5 V'];
  const out: string[] = [];
  for (const p of peersOf(t, picId, pin)) {
    const c = t.byId.get(p.componentId);
    if (!c) continue;
    if (c.kind === 'RES') {
      const other = p.pin === '1' ? '2' : '1';
      const farRail = railOf(t, c.id, other);
      const res = `${refOf(c)} (${c.value || 'RES'})`;
      if (farRail === 'GND') { out.push(`${res} vers la masse (résistance de tirage)`); continue; }
      if (farRail === 'VDD') { out.push(`${res} vers le +5 V (résistance de tirage)`); continue; }
      const far = peersOf(t, c.id, other).map((q) => t.byId.get(q.componentId) && endpointLabel(t.byId.get(q.componentId)!, q.pin)).filter(Boolean);
      out.push(far.length ? `${res} en série, puis ${far.join(', ')}` : `${res} : patte ${p.pin} (l’autre patte n’est reliée à rien)`);
      continue;
    }
    out.push(endpointLabel(c, p.pin));
  }
  return out;
}

/** Program role of each GPIO (signal or bus bit). */
function roles(program: Program | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!program) return out;
  for (const s of program.signals) {
    const what = s.dir === 'in' ? 'Entrée' : 'Sortie';
    out.set(s.pin, `${what} ${s.name}${s.label && s.label !== s.name ? ` — ${s.label}` : ''}`);
  }
  for (const b of program.buses) {
    busPins(b).forEach((p, k) => out.set(p, `${b.dir === 'in' ? 'Entrée' : 'Sortie'} ${b.name}, bit ${k}${b.device === 'bcd' ? ` (E${k})` : ''}`));
  }
  return out;
}

const KIND_ORDER: readonly ComponentInstance['kind'][] = [
  'PIC16F84A', 'LED', 'RES', 'LOGICSTATE', 'BUTTON', '7SEG-BCD', '7SEG-CC', 'TRAFFIC_LIGHTS', 'TORCH_LDR', 'CAP', 'CRYSTAL',
];

/** The wiring sheet of a schematic. */
export function buildWiringSheet(schematic: Schematic, opts: WiringOptions): WiringSheet {
  const netlist = buildNetlist(schematic);
  const t: Topo = {
    byId: new Map(schematic.components.map((c) => [c.id, c])),
    nets: new Map(netlist.nets.map((n) => [n.id, n])),
    netlist,
  };
  const clockHz = opts.clockHz ?? schematic.clockHz;
  const options = { ...opts, clockHz };

  const parts = schematic.components.filter((c) => c.kind !== 'POWER' && c.kind !== 'GROUND');
  parts.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || refOf(a).localeCompare(refOf(b), 'fr', { numeric: true }));
  const components: WiringComponent[] = parts.map((c) => ({
    ref: refOf(c),
    part: isisPartName(c),
    value: c.kind === 'RES' ? (c.value || '10k') : c.kind === 'PIC16F84A' ? '' : (c.value && c.value !== isisPartName(c) ? c.value : ''),
    settings: settingsOf(c, options),
  }));
  const terminals = {
    power: schematic.components.filter((c) => c.kind === 'POWER').length,
    ground: schematic.components.filter((c) => c.kind === 'GROUND').length,
  };

  const notes: string[] = [];
  const pic = schematic.components.find((c) => c.kind === 'PIC16F84A');
  const pinRole = roles(opts.program);
  const pins: WiringPin[] = [];
  if (pic) {
    for (const p of [...symbolFor(pic).pins].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
      if (p.hidden) {
        pins.push({ number: p.number ?? 0, name: p.name, role: p.name === 'VDD' ? 'Alimentation +5 V' : 'Masse', connections: ['reliée automatiquement par ISIS (broche cachée)'] });
        continue;
      }
      const gpio = gpioOfSchematicPin(p.name);
      pins.push({
        number: p.number ?? 0,
        name: p.name,
        role: gpio ? pinRole.get(gpio) ?? '' : '',
        connections: pinConnections(t, pic.id, p.name),
      });
    }
  } else {
    notes.push('Le schéma ne contient pas de PIC16F84A.');
  }

  // Every wire to draw: one entry per net with at least two pins (terminals named once, without their own pin).
  const wires: WiringWire[] = [];
  let k = 0;
  const netsInOrder = [...netlist.nets].sort((a, b) => netRank(a, pic) - netRank(b, pic));
  for (const net of netsInOrder) {
    const ends = net.pins
      .map((p) => ({ p, c: t.byId.get(p.componentId) }))
      .filter((x): x is { p: PinRef; c: ComponentInstance } => !!x.c && x.c.kind !== 'POWER' && x.c.kind !== 'GROUND')
      .map(({ p, c }) => endpointLabel(c, p.pin));
    if (net.rail) {
      if (ends.length === 0) continue;
      wires.push({ title: net.rail === 'GND' ? 'Masse (GROUND)' : '+5 V (POWER)', ends });
      continue;
    }
    if (ends.length < 2) continue;
    k++;
    wires.push({ title: `Liaison ${k}`, ends });
  }
  if (netlist.dangling.length > 0) notes.push(`${netlist.dangling.length} extrémité${netlist.dangling.length > 1 ? 's' : ''} de fil ne touche${netlist.dangling.length > 1 ? 'nt' : ''} rien dans le schéma.`);

  return {
    title: opts.title,
    clock: clockText(clockHz),
    config: `0x${(opts.config ?? 0x3ffb).toString(16).toUpperCase().padStart(4, '0')}`,
    hexFile: opts.hexFile,
    components,
    terminals,
    pins,
    wires,
    notes,
  };
}

/** Nets touching the PIC first (in pin number order), then the others, rails last. */
function netRank(net: Net, pic: ComponentInstance | undefined): number {
  if (net.rail) return 10_000 + (net.rail === 'GND' ? 1 : 0);
  if (!pic) return 5_000;
  const picPins = net.pins.filter((p) => p.componentId === pic.id);
  if (picPins.length === 0) return 5_000;
  const numbers = picPins.map((p) => symbolFor(pic).pins.find((x) => x.name === p.pin)?.number ?? 99);
  // DIL order is not the port order: rank by port order instead (RA0..RA4, RB0..RB7), as the student reads them.
  const order = picPins.map((p) => GPIO_ORDER.indexOf(p.pin)).filter((i) => i >= 0);
  return order.length ? Math.min(...order) : 100 + Math.min(...numbers);
}

const GPIO_ORDER = ['RA0', 'RA1', 'RA2', 'RA3', 'RA4/T0CKI', 'RB0/INT', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7', 'OSC1/CLKIN', 'OSC2/CLKOUT', 'MCLR'];

// ------------------------------------------------------------------------------------------------ HTML

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Standalone, printable page (A4 portrait, black on white, no external resources). */
export function renderWiringSheetHtml(sheet: WiringSheet, generatedOn = new Date()): string {
  const date = generatedOn.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const termText = [
    sheet.terminals.ground ? `${sheet.terminals.ground} × GROUND` : '',
    sheet.terminals.power ? `${sheet.terminals.power} × POWER` : '',
  ].filter(Boolean).join(', ');
  const rows = sheet.components.map((c) => `<tr><td class="mono">${esc(c.ref)}</td><td class="mono">${esc(c.part)}</td><td>${esc(c.value)}</td><td>${c.settings.map(esc).join('<br>')}</td></tr>`).join('\n');
  const pinRows = sheet.pins.map((p) => {
    const empty = p.connections.length === 0;
    return `<tr${empty ? ' class="unused"' : ''}><td class="num">${p.number}</td><td class="mono">${esc(p.name)}</td><td>${esc(p.role)}</td><td>${empty ? '—' : p.connections.map(esc).join('<br>')}</td></tr>`;
  }).join('\n');
  const wires = sheet.wires.map((w) => `<li><strong>${esc(w.title)}</strong> : ${w.ends.map(esc).join(' — ')}</li>`).join('\n');
  const notes = sheet.notes.length ? `<div class="notes">${sheet.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>` : '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Fiche de câblage — ${esc(sheet.title)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; color: #111; background: #fff; font: 11pt/1.4 -apple-system, 'Helvetica Neue', Arial, sans-serif; }
  @media print { body { padding: 0; } }
  h1 { font-size: 17pt; margin: 0 0 2px; }
  h2 { font-size: 12.5pt; margin: 20px 0 8px; padding-bottom: 3px; border-bottom: 1px solid #bbb; }
  .sub { color: #555; margin: 0 0 14px; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 6px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; }
  .facts span { white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid #e2e2e2; }
  th { font-size: 9.5pt; text-transform: uppercase; letter-spacing: .03em; color: #555; border-bottom: 1px solid #999; }
  .mono { font-family: Menlo, Consolas, monospace; font-size: 10pt; }
  .num { width: 3em; text-align: right; color: #555; }
  tr.unused td { color: #999; }
  ol, ul { margin: 0; padding-left: 20px; }
  li { margin: 2px 0; }
  .notes { margin-top: 12px; padding: 8px 10px; border-left: 3px solid #c2410c; background: #fdf1ea; }
  .notes p { margin: 0; }
  footer { margin-top: 22px; color: #777; font-size: 9pt; }
</style>
</head>
<body>
<h1>Fiche de câblage</h1>
<p class="sub">${esc(sheet.title)} — ${esc(date)}</p>
<div class="facts">
  <span><strong>Microcontrôleur :</strong> PIC16F84A</span>
  <span><strong>Horloge (CLOCK) :</strong> ${esc(sheet.clock)}</span>
  <span><strong>Programme :</strong> ${esc(sheet.hexFile)}</span>
  <span><strong>Mot de configuration :</strong> ${esc(sheet.config)}</span>
</div>
${notes}
<h2>1. Composants à placer</h2>
<table>
<thead><tr><th>Réf.</th><th>Composant (Pick Devices)</th><th>Valeur</th><th>À régler (double-clic)</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
${termText ? `<p>Terminaux : ${esc(termText)}.</p>` : ''}
<h2>2. Broches du PIC16F84A</h2>
<table>
<thead><tr><th>N°</th><th>Broche</th><th>Rôle dans le programme</th><th>Reliée à</th></tr></thead>
<tbody>
${pinRows}
</tbody>
</table>
<h2>3. Fils à tracer</h2>
<ul>
${wires || '<li>Aucun fil.</li>'}
</ul>
<h2>4. Dans ISIS</h2>
<ol>
  <li>Placer les composants du tableau 1 (mode composant, bouton « P » pour les chercher par leur nom).</li>
  <li>Placer les terminaux GROUND et POWER (mode terminal), puis tracer les fils de la partie 3.</li>
  <li>Double-cliquer sur le PIC : choisir le fichier ${esc(sheet.hexFile)} et l’horloge ${esc(sheet.clock)}.</li>
  <li>Lancer la simulation et comparer avec PIC Studio.</li>
</ol>
<footer>Fiche générée par PIC Studio.</footer>
</body>
</html>
`;
}
