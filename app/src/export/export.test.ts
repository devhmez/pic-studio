/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { parseSchematicJson } from '@pic/circuit';
import { parseProgramJson } from '@pic/program-model';
import { describe, expect, it } from 'vitest';
import { fileBase } from './names';
import { crc32, rasterScale, withPngDpi } from './raster';
import { buildWiringSheet, clockText, renderWiringSheetHtml } from './wiring';

const REPO = new URL('../../../', import.meta.url);
const read = (f: string) => readFileSync(new URL(`templates/${f}`, REPO), 'utf8');
const schematic = (id: string) => parseSchematicJson(read(`${id}.schematic.json`));
const program = (id: string) => parseProgramJson(read(`${id}.program.json`));

describe('file names', () => {
  it('turns project names into safe ASCII bases', () => {
    expect(fileBase('TP — Manipulation du registre STATUS')).toBe('tp-manipulation-du-registre-status');
    expect(fileBase('Démultiplexeur 1 vers 4 (v2)')).toBe('demultiplexeur-1-vers-4-v2');
    expect(fileBase('  ')).toBe('projet');
    expect(fileBase('x'.repeat(100)).length).toBe(60);
  });
});

describe('fiche de câblage', () => {
  it('lists the STATUS parts and what each PIC pin drives', () => {
    const sheet = buildWiringSheet(schematic('tp-status'), { title: 'TP STATUS', program: program('tp-status'), hexFile: 'tp-status.hex' });
    expect(sheet.clock).toBe('1MHz');
    expect(sheet.components.map((c) => `${c.ref}:${c.part}`)).toEqual([
      'U1:PIC16F84A', 'EGALITE:LED-GREEN', 'X_INFERIEUR:LED-RED', 'X_SUPERIEUR:LED-BLUE',
    ]);
    expect(sheet.components[0].settings).toEqual(['Program File : tp-status.hex', 'Processor Clock Frequency : 1MHz']);
    expect(sheet.terminals).toEqual({ power: 0, ground: 1 });
    expect(sheet.pins.map((p) => p.number)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    const rb0 = sheet.pins.find((p) => p.name === 'RB0/INT')!;
    expect(rb0.number).toBe(6);
    expect(rb0.connections).toEqual(['X_SUPERIEUR (LED-BLUE) : anode']);
    expect(rb0.role).toMatch(/^Sortie LED_SUP/);
    expect(sheet.pins.find((p) => p.name === 'RA0')!.connections).toEqual([]);
    expect(sheet.pins.find((p) => p.name === 'VDD')!.connections[0]).toMatch(/automatiquement/);
    const ground = sheet.wires.find((w) => w.title.startsWith('Masse'))!;
    expect(ground.ends).toHaveLength(3);
    expect(ground.ends.every((e) => e.endsWith('cathode'))).toBe(true);
  });

  it('follows series resistors (demux) and names the inputs', () => {
    const sheet = buildWiringSheet(schematic('tp1-demux'), { title: 'Demux', program: program('tp1-demux'), hexFile: 'demux.hex' });
    const rb0 = sheet.pins.find((p) => p.name === 'RB0/INT')!;
    expect(rb0.connections).toHaveLength(1);
    expect(rb0.connections[0]).toMatch(/^R\d \(220\) en série, puis D\d \(LED-[A-Z]+\) : anode$/);
    const ra0 = sheet.pins.find((p) => p.name === 'RA0')!;
    expect(ra0.connections).toEqual(['LS1 (LOGICSTATE)']);
    expect(ra0.role).toMatch(/^Entrée L0/);
    expect(sheet.components.find((c) => c.ref === 'LS2')!.settings).toEqual(['État de départ : 1']);
    // Liaisons are numbered in port order: the first one is RA0's.
    expect(sheet.wires[0].ends[0]).toMatch(/U1 : broche 17 \(RA0\)/);
  });

  it('describes pull-downs, the LDR divider and the BCD display', () => {
    const pupitre = buildWiringSheet(schematic('tp-pupitre'), { title: 'Pupitre', hexFile: 'p.hex' });
    const ra0 = pupitre.pins.find((p) => p.name === 'RA0')!;
    expect(ra0.connections).toEqual(expect.arrayContaining(['VALIDER (BUTTON) : patte 1', 'R1 (10k) vers la masse (résistance de tirage)']));
    const traffic = buildWiringSheet(schematic('tp-traffic'), { title: 'Feu', hexFile: 'f.hex' });
    expect(traffic.clock).toBe('8MHz');
    expect(traffic.pins.find((p) => p.name === 'RB0/INT')!.connections).toEqual(['SEG1 (7SEG-BCD-BLUE) : entrée E0 (poids faible)']);
    expect(traffic.pins.find((p) => p.name === 'RA0')!.connections).toEqual(['TL1 (TRAFFIC LIGHTS) : feu rouge (R)']);
    expect(traffic.terminals).toEqual({ power: 1, ground: 1 });
  });

  it('renders a standalone printable page with escaped text', () => {
    const sheet = buildWiringSheet(schematic('tp-status'), { title: 'TP <STATUS> & co', hexFile: 'a.hex' });
    const html = renderWiringSheetHtml(sheet, new Date(2026, 9, 13));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('TP &lt;STATUS&gt; &amp; co');
    expect(html).toContain('13 octobre 2026');
    expect(html).toContain('@page');
    expect(html).not.toMatch(/<script|<link|https?:\/\//);
    expect(clockText(32768)).toBe('32.768kHz');
  });
});

describe('PNG resolution', () => {
  // A 1×1 PNG (IHDR, IDAT, IEND).
  const tiny = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

  const chunks = (png: Uint8Array) => {
    const out: string[] = [];
    for (let at = 8; at + 12 <= png.length;) {
      const len = (png[at] << 24) | (png[at + 1] << 16) | (png[at + 2] << 8) | png[at + 3];
      out.push(String.fromCharCode(...png.subarray(at + 4, at + 8)));
      at += 12 + len;
    }
    return out;
  };

  it('inserts a pHYs chunk after IHDR with a valid CRC', () => {
    const out = withPngDpi(tiny, 300);
    expect(chunks(out)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    const at = 8 + 25;
    const ppm = (out[at + 8] << 24 | out[at + 9] << 16 | out[at + 10] << 8 | out[at + 11]) >>> 0;
    expect(ppm).toBe(Math.round(300 / 0.0254));
    const crc = (out[at + 17] << 24 | out[at + 18] << 16 | out[at + 19] << 8 | out[at + 20]) >>> 0;
    expect(crc).toBe(crc32(out, at + 4, at + 17));
    // Replacing keeps a single pHYs.
    expect(chunks(withPngDpi(out, 150))).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    expect(withPngDpi(new Uint8Array([1, 2, 3]), 300)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('caps the raster scale to safe canvas sizes', () => {
    expect(rasterScale(600, 800, 3.125)).toBe(3.125);
    expect(rasterScale(10_000, 500, 3.125)).toBeCloseTo(1.2);
  });
});
