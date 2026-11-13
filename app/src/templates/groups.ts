// Course chapters of the template picker, and the cached schematic thumbnails.
import { schematicToSvg, type Schematic } from '@pic/circuit';

export interface TemplateLike {
  id: string;
  title: string;
  chapter: string | null;
  description: string;
}

export interface TemplateGroup<T extends TemplateLike> {
  key: string;
  title: string;
  subtitle: string;
  items: T[];
}

interface ChapterInfo { key: string; title: string; subtitle: string; order: number }

/** How the course groups its TPs (Ch5 and Ch6 share one heading: both are about interrupts). */
const CHAPTERS: Readonly<Record<number, ChapterInfo>> = {
  1: { key: 'ch1', title: 'Chapitre 1 — Premiers pas', subtitle: 'TP0 : allumer une LED, la commander par un bouton', order: 1 },
  2: { key: 'ch2', title: 'Chapitre 2 — Entrées / sorties', subtitle: 'Démultiplexeur 1 vers 4', order: 2 },
  3: { key: 'ch3', title: 'Chapitre 3 — Registre STATUS et afficheur', subtitle: 'Comparaison avec Z et C, boîtier de vote', order: 3 },
  4: { key: 'ch4', title: 'Chapitre 4 — Mémoire programme', subtitle: 'Feu tricolore, pupitre de jeu', order: 4 },
  5: { key: 'ch56', title: 'Chapitres 5 et 6 — Interruptions', subtitle: 'TP4 INTE, RB0/INT, changement d’état sur RB4 à RB7', order: 5 },
  6: { key: 'ch56', title: 'Chapitres 5 et 6 — Interruptions', subtitle: 'TP4 INTE, RB0/INT, changement d’état sur RB4 à RB7', order: 5 },
};

/** 'Chapitre 3' → 3 (null when unknown). */
export function chapterNumber(chapter: string | null): number | null {
  const m = chapter ? /(\d+)/.exec(chapter) : null;
  return m ? Number(m[1]) : null;
}

/** Templates grouped by course chapter, in course order; templates of unknown chapters go last. */
export function groupTemplates<T extends TemplateLike>(templates: readonly T[]): TemplateGroup<T>[] {
  const groups = new Map<string, TemplateGroup<T> & { order: number }>();
  for (const t of templates) {
    const n = chapterNumber(t.chapter);
    const info = n !== null ? CHAPTERS[n] : undefined;
    const meta = info ?? (n !== null
      ? { key: `ch${n}`, title: `Chapitre ${n}`, subtitle: '', order: 10 + n }
      : { key: 'other', title: 'Autres modèles', subtitle: '', order: 100 });
    let g = groups.get(meta.key);
    if (!g) {
      g = { key: meta.key, title: meta.title, subtitle: meta.subtitle, items: [], order: meta.order };
      groups.set(meta.key, g);
    }
    g.items.push(t);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...g }) => g);
}

const previews = new Map<string, string>();

/** Thumbnail of a template's circuit (ISIS colours, no grid), as a data: URL for an <img>. Cached per id. */
export function schematicPreviewUrl(id: string, schematic: Schematic): string {
  let url = previews.get(id);
  if (!url) {
    let svg: string;
    try {
      svg = schematicToSvg(schematic, { grid: false, placeholders: false, margin: 2, pxPerGrid: 8 });
    } catch {
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
    }
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    previews.set(id, url);
  }
  return url;
}
