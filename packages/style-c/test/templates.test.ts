/// <reference types="node" />
// Golden test of the template files written from the TypeScript sources:
//   templates/<id>.program.json, templates/<id>.c, templates/index.json, and the Ch5–Ch6 schematics.
// Regenerate with:  UPDATE_TEMPLATES=1 npx vitest run packages/style-c/test/templates.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildNetlist, parseSchematicFile, serializeSchematic } from '@pic/circuit';
import { parseProgramJson, serializeProgram, validate } from '@pic/program-model';
import { generate } from '../src';
import { TEMPLATE_PROGRAMS } from './template-programs';
import { NEW_SCHEMATICS } from './template-schematics';

const UPDATE = process.env.UPDATE_TEMPLATES === '1';
const path = (file: string) => fileURLToPath(new URL(`../../../templates/${file}`, import.meta.url));
const read = (file: string) => readFileSync(path(file), 'utf8');

/** One entry of templates/index.json. */
export interface TemplateIndexEntry {
  id: string;
  title: string;
  chapter: number;
  description: string;
  schematic: string;
  program: string;
  source: string;
  clockHz: number;
}

function expectedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const index: TemplateIndexEntry[] = [];
  for (const t of TEMPLATE_PROGRAMS) {
    const p = t.build();
    files.set(`${t.id}.program.json`, serializeProgram(p));
    files.set(`${t.id}.c`, generate(p));
    index.push({
      id: t.id,
      title: p.title,
      chapter: t.chapter,
      description: p.description ?? '',
      schematic: `${t.id}.schematic.json`,
      program: `${t.id}.program.json`,
      source: `${t.id}.c`,
      clockHz: p.clockHz,
    });
  }
  for (const s of NEW_SCHEMATICS) files.set(`${s.id}.schematic.json`, serializeSchematic(s.build(), s.meta));
  files.set('index.json', `${JSON.stringify(index, null, 2)}\n`);
  return files;
}

const EXPECTED = expectedFiles();
if (UPDATE) for (const [file, text] of EXPECTED) writeFileSync(path(file), text);

describe('templates on disk', () => {
  for (const [file, text] of EXPECTED) {
    it(`${file} matches its TypeScript source`, () => {
      expect(read(file)).toBe(text);
    });
  }

  it('index.json lists every template with existing files and matching clocks', () => {
    const index = JSON.parse(read('index.json')) as TemplateIndexEntry[];
    expect(index.map((e) => e.id)).toEqual([
      'tp0-exemple1', 'tp0-exemple2', 'tp1-demux', 'tp-status', 'tp-vote', 'tp-traffic', 'tp-pupitre',
      'tp4-inte', 'ch5-manip-rb0', 'tp-traffic-int', 'tp5-int-rb0', 'ch6-exo-rbie', 'tp6-rbie',
    ]);
    for (const e of index) {
      for (const f of [e.schematic, e.program, e.source]) expect(existsSync(path(f)), f).toBe(true);
      const schematic = parseSchematicFile(read(e.schematic));
      const program = parseProgramJson(read(e.program));
      expect(schematic.clockHz).toBe(e.clockHz);
      expect(program.clockHz).toBe(e.clockHz);
      expect(e.title).toBe(program.title);
      expect(e.description.length).toBeGreaterThan(20);
      expect(e.chapter).toBeGreaterThanOrEqual(1);
    }
  });

  it('every program validates against its schematic without errors or warnings', () => {
    for (const t of TEMPLATE_PROGRAMS) {
      const program = parseProgramJson(read(`${t.id}.program.json`));
      const schematic = parseSchematicFile(read(`${t.id}.schematic.json`));
      expect(validate(program, schematic), t.id).toEqual([]);
    }
  });

  it('every signal names a component of its schematic', () => {
    for (const t of TEMPLATE_PROGRAMS) {
      const program = parseProgramJson(read(`${t.id}.program.json`));
      const ids = new Set(parseSchematicFile(read(`${t.id}.schematic.json`)).components.map((c) => c.id));
      for (const s of program.signals) if (s.componentId) expect(ids.has(s.componentId), `${t.id}: ${s.componentId}`).toBe(true);
    }
  });

  it('the Ch5–Ch6 schematics have no dangling wire and keep U1 at the origin', () => {
    for (const s of NEW_SCHEMATICS) {
      const schematic = s.build();
      expect(buildNetlist(schematic).dangling).toEqual([]);
      expect(schematic.components.find((c) => c.kind === 'PIC16F84A')).toMatchObject({ id: 'U1', at: { x: 0, y: 0 }, rotation: 0 });
    }
  });
});

describe('the drawn Ch5–Ch6 schematics wire the énoncé pin plan', () => {
  const netsOf = (id: string): string[] => {
    const s = parseSchematicFile(read(`${id}.schematic.json`));
    return buildNetlist(s).nets.filter((n) => n.pins.length > 1)
      .map((n) => n.pins.map((p) => `${p.componentId}.${p.pin}`).sort().join(' ')).sort();
  };

  it('ch5-manip-rb0: LEDs on RA1 / RA2 to GND, BOUTON to +5 V with a 10k pull-down on RB0', () => {
    const nets = netsOf('ch5-manip-rb0');
    expect(nets).toContain('D1.A U1.RA1');
    expect(nets).toContain('D2.A U1.RA2');
    expect(nets.find((n) => n.includes('U1.RB0/INT'))).toMatch(/^BOUTON\.1 R\d\.\d U1\.RB0\/INT$/);
    expect(nets.find((n) => n.includes('BOUTON.2'))).toMatch(/PWR\d\.VDD/);
  });

  it('ch6-exo-rbie: 7SEG-BCD on RA0..RA3; B4..B7 on RB4..RB7, each with its own pull-down, all to one +5 V rail', () => {
    const nets = netsOf('ch6-exo-rbie');
    for (const k of [0, 1, 2, 3]) expect(nets).toContain(`SEG1.E${k} U1.RA${k}`);
    for (const k of [4, 5, 6, 7]) {
      const node = nets.find((n) => n.includes(`U1.RB${k}`))!;
      expect(node, `RB${k}`).toMatch(new RegExp(`^B${k}\\.1 R\\d\\.1 U1\\.RB${k}$`));
    }
    const rail = nets.find((n) => n.includes('PWR1.VDD'))!;
    expect(rail).toBe('B4.2 B5.2 B6.2 B7.2 PWR1.VDD');
    // The four GROUND symbols are one global rail, joined by the four pull-downs.
    expect(nets.filter((n) => n.includes('GND'))).toEqual(['GND1.GND GND2.GND GND3.GND GND4.GND R1.2 R2.2 R3.2 R4.2']);
  });
});
