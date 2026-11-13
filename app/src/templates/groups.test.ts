/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { parseSchematicJson } from '@pic/circuit';
import { describe, expect, it } from 'vitest';
import { chapterNumber, groupTemplates, schematicPreviewUrl } from './groups';

const REPO = new URL('../../../', import.meta.url);
const index = JSON.parse(readFileSync(new URL('templates/index.json', REPO), 'utf8')) as { id: string; title: string; chapter: number; description: string }[];
const entries = index.map((t) => ({ id: t.id, title: t.title, description: t.description, chapter: `Chapitre ${t.chapter}` }));

describe('template groups', () => {
  it('reads chapter numbers', () => {
    expect(chapterNumber('Chapitre 3')).toBe(3);
    expect(chapterNumber(null)).toBeNull();
    expect(chapterNumber('Introduction')).toBeNull();
  });

  it('groups the course templates by chapter, interrupts together', () => {
    const groups = groupTemplates(entries);
    expect(groups.map((g) => g.key)).toEqual(['ch1', 'ch2', 'ch3', 'ch4', 'ch56']);
    expect(groups.map((g) => g.items.map((t) => t.id))).toEqual([
      ['tp0-exemple1', 'tp0-exemple2'],
      ['tp1-demux'],
      ['tp-status', 'tp-vote'],
      ['tp-traffic', 'tp-pupitre'],
      ['tp4-inte', 'ch5-manip-rb0', 'tp-traffic-int', 'tp5-int-rb0', 'ch6-exo-rbie', 'tp6-rbie'],
    ]);
    expect(groups[3].subtitle).toContain('Feu tricolore');
  });

  it('puts unknown chapters last', () => {
    const groups = groupTemplates([
      { id: 'x', title: 'X', chapter: null, description: '' },
      { id: 'a', title: 'A', chapter: 'Chapitre 9', description: '' },
      { id: 'b', title: 'B', chapter: 'Chapitre 2', description: '' },
    ]);
    expect(groups.map((g) => g.title)).toEqual(['Chapitre 2 — Entrées / sorties', 'Chapitre 9', 'Autres modèles']);
  });

  it('draws cached circuit thumbnails', () => {
    const s = parseSchematicJson(readFileSync(new URL('templates/tp-status.schematic.json', REPO), 'utf8'));
    const url = schematicPreviewUrl('tp-status', s);
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true);
    expect(schematicPreviewUrl('tp-status', s)).toBe(url);
  });
});
