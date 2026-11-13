import { describe, expect, it } from 'vitest';
import { importDsn } from '../src/dsn';
import { parseSchematicFile, parseSchematicJson, serializeSchematic, validateSchematic } from '../src/schematic-io';
import { schematicToSvg } from '../src/svg';
import { createCircuitSimulator } from '../src/simulator';
import { FakeMcu, readBytes } from './helpers';

describe('schematic JSON', () => {
  it('round-trips an imported circuit', () => {
    const s = importDsn(readBytes('cours/tp demux.DSN'));
    const text = serializeSchematic(s, { name: 'Démux' });
    expect(text).toContain('"name": "Démux"');
    expect(text).toContain('"points": [{ "x": -15, "y": -11 }, { "x": -14, "y": -11 }');
    expect(parseSchematicJson(text)).toEqual(s);
    expect(parseSchematicFile(text)).toEqual({ name: 'Démux', ...s });
  });

  it('rejects invalid files with French messages', () => {
    expect(() => parseSchematicJson('{')).toThrow(/JSON invalide/);
    const { schematic, errors } = validateSchematic({
      clockHz: 1e6,
      components: [
        { id: 'A', kind: 'LED', ref: 'D1', at: { x: 0, y: 0 }, rotation: 45, props: {} },
        { id: 'A', kind: 'TUBE', ref: '', at: { x: 0 }, rotation: 0, props: {} },
      ],
      wires: [{ id: 'W1', points: [{ x: 0, y: 0 }] }],
    });
    expect(schematic).toBeNull();
    expect(errors).toEqual([
      'Composant n°1 (A) : rotation invalide (0, 90, 180 ou 270).',
      'Composant n°2 (A) : identifiant en double.',
      'Composant n°2 (A) : type inconnu « TUBE ».',
      'Composant n°2 (A) : position (at) invalide.',
      'Fil n°1 (W1) : au moins deux points (x, y) sont nécessaires.',
    ]);
    expect(validateSchematic({ components: [], wires: [] }).errors).toEqual(['clockHz doit être une fréquence positive (Hz).']);
  });
});

describe('SVG export', () => {
  it('draws every component, the junction dots and, while simulating, the pin-state squares', () => {
    const s = importDsn(readBytes('cours/manipulation status.DSN'));
    const svg = schematicToSvg(s);
    expect(svg.startsWith('<svg')).toBe(true);
    for (const c of s.components) expect(svg).toContain(`data-id="${c.id}"`);
    expect(svg).toContain('X_SUPERIEUR');
    expect(svg).toContain('<circle cx="21" cy="5" r="0.2"');
    expect(svg).not.toContain('#FF4040');
    const mcu = new FakeMcu();
    mcu.drive.set('RB0', 1);
    const sim = createCircuitSimulator(s, mcu, 'U1');
    const live = schematicToSvg(s, { simulator: sim, grid: false });
    expect(live).toContain('#FF4040');
    expect(live).toContain('#4040FF');
    expect(live).toContain('#808080');
  });
});
