// Deterministic text measurement (no DOM, no canvas): the layout must give the same result in Node tests and in the
// browser. Advance widths (1/1000 em) were read from the macOS system fonts the SVG asks for first:
//   serif        Georgia                  (box text, Début / Fin)
//   serifBold    Georgia Bold             (CONFIGURATION / INITIALISATION headings, chart titles)
//   sans         Arial                    (diamond text and oui / non; the prof's Calibri is narrower, so Arial is a
//                                          safe upper bound wherever Calibri is installed)
//   serifItalic  Times New Roman Italic   (« Boucle infinie » tag)
// Characters outside the table count as a wide glyph (0.62 em), so an estimate never under-sizes a box.

/** The character set of the width tables, in table order. */
const CHARSET =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'
  + 'ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜàâäçéèêëîïôöùûüœŒ«»’‘“”—–…µ°²×÷';

export type MetricsFace = 'serif' | 'serifBold' | 'sans' | 'sansBold' | 'serifItalic';

const TABLES: Readonly<Record<MetricsFace, readonly number[]>> = {
  serif: [
    241, 331, 412, 643, 610, 817, 710, 215, 375, 375, 472, 643, 270, 374, 270, 469, 614, 430, 559, 552, 565, 528, 566, 502,
    596, 566, 313, 313, 643, 643, 643, 479, 929, 671, 654, 642, 749, 653, 599, 725, 815, 390, 518, 694, 604, 927, 767, 744,
    610, 744, 702, 561, 619, 756, 667, 976, 710, 615, 602, 375, 469, 375, 643, 643, 500, 504, 560, 454, 574, 483, 325, 509,
    582, 293, 292, 536, 286, 881, 591, 539, 571, 560, 410, 432, 345, 575, 497, 737, 505, 492, 444, 430, 375, 430, 643, 671,
    671, 671, 642, 653, 653, 653, 653, 390, 390, 744, 744, 756, 756, 756, 504, 504, 504, 454, 483, 483, 483, 483, 293, 293,
    539, 539, 575, 575, 575, 816, 998, 581, 581, 227, 227, 410, 410, 857, 643, 807, 579, 419, 500, 643, 643,
  ],
  serifBold: [
    254, 376, 510, 703, 641, 879, 799, 269, 447, 447, 482, 703, 328, 379, 328, 472, 701, 490, 626, 625, 649, 599, 648, 554,
    676, 648, 367, 367, 703, 703, 703, 548, 967, 758, 757, 715, 834, 721, 671, 807, 913, 446, 595, 817, 686, 1023, 839, 820,
    701, 820, 797, 649, 684, 833, 762, 1126, 809, 732, 689, 447, 472, 447, 703, 703, 500, 596, 646, 531, 663, 572, 393, 577,
    680, 354, 346, 632, 344, 1016, 690, 636, 658, 648, 520, 513, 397, 677, 567, 863, 588, 562, 525, 500, 388, 500, 703, 758,
    758, 758, 715, 721, 721, 721, 721, 446, 446, 820, 820, 833, 833, 833, 596, 596, 596, 531, 572, 572, 572, 572, 354, 354,
    636, 636, 677, 677, 677, 938, 1101, 610, 610, 269, 269, 519, 519, 928, 703, 942, 668, 420, 552, 703, 703,
  ],
  sans: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
    556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 667,
    667, 667, 722, 667, 667, 667, 667, 278, 278, 778, 778, 722, 722, 722, 556, 556, 556, 500, 556, 556, 556, 556, 278, 278,
    556, 556, 556, 556, 556, 944, 1000, 556, 556, 222, 222, 333, 333, 1000, 556, 1000, 576, 400, 333, 584, 549,
  ],
  sansBold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
    611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 722,
    722, 722, 722, 667, 667, 667, 667, 278, 278, 778, 778, 722, 722, 722, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
    611, 611, 611, 611, 611, 944, 1000, 556, 556, 278, 278, 500, 500, 1000, 556, 1000, 576, 400, 333, 584, 549,
  ],
  serifItalic: [
    250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500,
    500, 500, 333, 333, 675, 675, 675, 500, 920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833, 667, 722,
    611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389, 278, 389, 422, 500, 333, 500, 500, 444, 500, 444, 278, 500,
    500, 278, 278, 444, 278, 722, 500, 500, 500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400, 275, 400, 541, 611,
    611, 611, 667, 611, 611, 611, 611, 333, 333, 722, 722, 722, 722, 722, 500, 500, 500, 444, 444, 444, 444, 444, 278, 278,
    500, 500, 500, 500, 500, 667, 944, 500, 500, 333, 333, 556, 556, 889, 500, 889, 576, 400, 300, 675, 549,
  ],
};

/** Width (1/1000 em) of a character missing from the tables. */
const UNKNOWN_WIDTH = 620;

const INDEX: ReadonlyMap<string, number> = new Map([...CHARSET].map((ch, i) => [ch, i]));

/** Width in px of `text` set in `face` at `size` px (sum of advance widths, no kerning). */
export function textWidth(text: string, face: MetricsFace, size: number): number {
  const table = TABLES[face];
  let units = 0;
  for (const ch of text) {
    const i = INDEX.get(ch);
    units += i === undefined ? UNKNOWN_WIDTH : table[i];
  }
  return (units * size) / 1000;
}

/**
 * Greedy word wrap: split `text` at spaces so that every line is at most `maxWidth` px wide. A single word longer
 * than `maxWidth` stays on its own line (it is never cut).
 */
export function wrapText(text: string, face: MetricsFace, size: number, maxWidth: number): string[] {
  if (textWidth(text, face, size) <= maxWidth) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && textWidth(candidate, face, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}
