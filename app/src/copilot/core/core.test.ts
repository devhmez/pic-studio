// Small pure pieces of the copilot: answer reader, prompts, énoncé text, usage line, persistence.
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { blankProject } from '../../state/store';
import { DEMUX_ANSWER } from './answers.fixtures';
import { capText, docxToText, docxXmlToText, enonceKind, pdfItemsToText } from './enonceText';
import { fingerprint, uuid, UUID_RE } from './ids';
import {
  conversationKey, loadConversation, recapOf, saveConversation, summarize, toStored, type ChatMessage, type KeyValueStorage,
} from './messages';
import { buildCorrectionPrompt, buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import { ANSWER_JSON_SCHEMA, readAnswer } from './schema';
import { newConversation } from './turn';
import { addCall, emptyUsage, formatUsage, modelLabel } from './usage';
import { verifyAnswer } from './verify';

describe('readAnswer', () => {
  it('reads a full answer and normalises loose values', () => {
    const r = readAnswer({
      reponse: ' Fait. ',
      questions: ['', 'Quelle broche ?'],
      circuit: {
        horloge_mhz: '8',
        composants: [{ ref: 'FEU', type: 'traffic lights' }, { ref: 'AFF', type: '7seg' }, { ref: 'X', type: 'MOTOR' }],
        liaisons: [{ de: 'U1.RA0', vers: 'FEU.R' }, { de: 'U1.RA1' }],
      },
      code: 'void main() {\r\n}\r\n',
      tests: [{ description: 't', actions: [{ ref: 'BP', etat: '1' }, { ref: 'BP', appui_ms: 100 }, { attendre_ms: 50 }, { foo: 1 }], attendu: [{ ref: 'D1', etat: true }, { afficheur: 'AFF', valeur: 10 }] }],
    })!;
    expect(r.answer.reponse).toBe('Fait.');
    expect(r.answer.questions).toEqual(['Quelle broche ?']);
    expect(r.answer.circuit?.horloge_mhz).toBe(8);
    expect(r.answer.circuit?.composants.map((c) => c.type)).toEqual(['TRAFFIC_LIGHTS', '7SEG-BCD']);
    expect(r.answer.circuit?.liaisons).toHaveLength(1);
    expect(r.answer.code).toBe('void main() {\n}\n');
    expect(r.answer.tests?.[0].actions).toEqual([{ ref: 'BP', etat: 1 }, { ref: 'BP', appui_ms: 100 }, { attendre_ms: 50 }]);
    expect(r.answer.tests?.[0].attendu).toEqual([{ ref: 'D1', etat: 1 }, { afficheur: 'AFF', valeur: '10' }]);
    expect(r.problems).toHaveLength(3);
  });

  it('rejects what is not an object and accepts a JSON string', () => {
    expect(readAnswer(null)).toBeNull();
    expect(readAnswer('pas du json')).toBeNull();
    expect(readAnswer('{"reponse":"ok"}')?.answer).toEqual({ reponse: 'ok' });
  });

  it('defaults a bad clock to 1 MHz and says so', () => {
    const r = readAnswer({ reponse: '', circuit: { horloge_mhz: 50, composants: [{ ref: 'D1', type: 'LED' }], liaisons: [] } })!;
    expect(r.answer.circuit?.horloge_mhz).toBe(1);
    expect(r.problems[0]).toMatch(/horloge_mhz/);
  });

  it('has a compact draft-07 schema', () => {
    expect(JSON.stringify(ANSWER_JSON_SCHEMA).length).toBeLessThan(1600);
    expect(ANSWER_JSON_SCHEMA.required).toEqual(['reponse']);
  });
});

describe('prompts', () => {
  it('keeps the system prompt short and in French, with the course conventions', () => {
    // ~1 token per 3.5 characters of French: stay well under 1 500 tokens.
    expect(SYSTEM_PROMPT.length / 3.5).toBeLessThan(1500);
    for (const s of ['TRIS : 1 = entrée, 0 = sortie', 'Delay_ms', 'while(1)', 'LOGICSTATE', 'BUTTON', 'TORCH_LDR', 'E0', 'questions', 'relâchement', '8 pour le feu tricolore']) {
      expect(SYSTEM_PROMPT).toContain(s);
    }
  });

  it('builds the student turn and the correction report', () => {
    const p = buildUserPrompt({ request: 'Fais le TP', project: null, recap: undefined });
    expect(p).toBe("DEMANDE DE L'ÉTUDIANT :\nFais le TP\n\nPROJET ACTUEL : vide (un PIC16F84A seul).");
    const c = buildCorrectionPrompt({ answer: [], circuit: ['a'], compile: ['ligne 3 : x'], consistency: [], tests: Array.from({ length: 10 }, (_, i) => `t${i}`), missing: [] }, 1, 2);
    expect(c).toMatch(/^VÉRIFICATION AUTOMATIQUE de ta réponse \(correction 1\/2\)/);
    expect(c).toContain('Circuit :\n- a');
    expect(c).toContain('Compilation MikroC :\n- ligne 3 : x');
    expect(c).toContain('- … et 2 autre(s)');
    expect(c).not.toContain('Cohérence');
  });
});

describe('énoncé text', () => {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
    <w:p><w:r><w:t>TP : Feu Tricolore</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Rouge sur </w:t></w:r><w:r><w:t>RA0 &amp; orange</w:t></w:r><w:r><w:tab/><w:t>(RA1)</w:t></w:r></w:p>
    <w:p/>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Broche</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Rôle</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>RA3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>capteur</w:t></w:r></w:p><w:p><w:r><w:t>(LDR)</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:delText>supprimé</w:delText><w:t>Fin</w:t></w:r></w:p>
  </w:body></w:document>`;

  it('turns word/document.xml into paragraphs, list items and table rows', () => {
    expect(docxXmlToText(xml)).toBe('TP : Feu Tricolore\n• Rouge sur RA0 & orange\t(RA1)\n\nBroche | Rôle\nRA3 | capteur (LDR)\nFin');
  });

  it('reads a real .docx zip and refuses other files', () => {
    const docx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml) });
    expect(docxToText(docx)).toContain('RA3 | capteur (LDR)');
    expect(enonceKind('tp.docx', docx)).toBe('docx');
    expect(() => docxToText(strToU8('hello'))).toThrow(/Word/);
  });

  it('glues pdf.js items into lines and pages', () => {
    const it = (str: string, x: number, y: number, w = str.length * 5, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], width: w, height: 10, hasEOL });
    const text = pdfItemsToText([
      [it('Feu', 0, 700), it('tricolore', 20, 700), it('RA0', 0, 680, 15, true), it('Rouge', 0, 660)],
      [it('Page 2', 0, 700)],
    ]);
    expect(text).toBe('Feu tricolore\nRA0\nRouge\n\nPage 2');
  });

  it('caps the text at a paragraph boundary', () => {
    const long = `${'a'.repeat(9000)}\n\n${'b'.repeat(5000)}`;
    const c = capText(long, 12000);
    expect(c.truncated).toBe(true);
    expect(c.text).toBe('a'.repeat(9000));
    expect(c.originalLength).toBe(14002);
    expect(capText('court').truncated).toBe(false);
  });

  it('recognises file kinds', () => {
    expect(enonceKind('a.pdf')).toBe('pdf');
    expect(enonceKind('x.bin', new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('pdf');
    expect(enonceKind('photo.JPG')).toBe('image');
    expect(enonceKind('old.doc')).toBe('doc');
    expect(enonceKind('notes.txt')).toBe('text');
  });
});

describe('usage', () => {
  it('sums tokens and takes the cost as the difference of cumulative totals', () => {
    let u = emptyUsage();
    let base = 0.05; // earlier requests of the same session
    ({ total: u, baseline: base } = addCall(u, { inputTokens: 9000, outputTokens: 1400, cacheReadTokens: 2000, cacheCreationTokens: 0, sessionCostUsd: 0.06, durationMs: 1000, model: 'claude-haiku-4-5' }, base));
    ({ total: u, baseline: base } = addCall(u, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessionCostUsd: 0.07, durationMs: 500 }, base));
    expect(u.tokens).toBe(12400);
    expect(u.costUsd).toBeCloseTo(0.02);
    expect(u.calls).toBe(2);
    expect(base).toBe(0.07);
    expect(formatUsage(u)).toBe('12 400 jetons · ≈ 0,02 $ en équivalent API (inclus dans votre abonnement Claude)');
    expect(formatUsage({ ...u, costUsd: 0.001 })).toContain('< 0,01 $');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku');
  });

  it('treats a total lower than the baseline as a new session', () => {
    const { total } = addCall(emptyUsage(), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, sessionCostUsd: 0.01, durationMs: 1 }, 0.5);
    expect(total.costUsd).toBeCloseTo(0.01);
  });
});

describe('ids', () => {
  it('makes v4 UUIDs and stable fingerprints', () => {
    expect(uuid()).toMatch(UUID_RE);
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
  });
});

describe('persistence', () => {
  const memory = (): KeyValueStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
  };

  it('keeps messages (not the usage) and the payload of the last pending proposal only', async () => {
    const p = blankProject();
    const report = await verifyAnswer(DEMUX_ANSWER, { name: 'P', schematic: p.schematic, source: p.source, clockHz: p.clockHz });
    const summary = summarize(report, p);
    expect(summary.parts).toContain('D0 · LED jaune');
    expect(summary.pins).toEqual(['RA0', 'RA1', 'RB0', 'RB1', 'RB2', 'RB3']);
    expect(summary.tests.every((t) => t.passed)).toBe(true);
    const payload = { schematic: report.schematic, source: report.source, program: report.program, clockHz: report.clockHz, fingerprint: 'f', latest: true };
    const messages: ChatMessage[] = [
      { id: '1', role: 'student', text: 'Fais le démux', at: 1, attachment: { name: 'demux.pdf', chars: 900, truncated: false } },
      { id: '2', role: 'copilot', text: 'Voilà', at: 2, proposal: { summary, status: 'ignored', payload }, usage: { tokens: 1, costUsd: 1, durationMs: 1, calls: 1 } },
      { id: '3', role: 'copilot', text: 'Version 2', at: 3, proposal: { summary, status: 'pending', payload } },
    ];
    const storage = memory();
    const key = conversationKey({ fileName: null, templateId: 'tp1-demux' });
    expect(key).toBe('pic-studio.copilot.v1:template:tp1-demux');
    const conv = { ...newConversation(), started: true, costBaseline: 0.04 };
    saveConversation(storage, key, toStored(conv, 'sonnet', messages));
    const raw = storage.data.get(key)!;
    expect(raw).not.toContain('"usage"');
    const back = loadConversation(storage, key)!;
    expect(back.model).toBe('sonnet');
    expect(back.conversation).toEqual(conv);
    expect(back.messages).toHaveLength(3);
    expect(back.messages[1].proposal?.payload).toBeUndefined();
    expect(back.messages[2].proposal?.payload?.source).toBe(report.source);
    expect(back.messages[0].attachment?.name).toBe('demux.pdf');
    expect(recapOf(back.messages)).toContain('Étudiant : Fais le démux');
  });

  it('survives garbage and an empty conversation', () => {
    const storage = memory();
    storage.setItem('k', '{not json');
    expect(loadConversation(storage, 'k')).toBeNull();
    storage.setItem('k', JSON.stringify({ version: 1, conversation: { sessionId: 's' }, messages: [{ role: 'x' }, { id: 'a', role: 'copilot', text: 't', proposal: { summary: {}, status: 'pending' } }] }));
    const c = loadConversation(storage, 'k')!;
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].proposal?.status).toBe('ignored');
    saveConversation(storage, 'k', toStored(newConversation(), 'haiku', []));
    expect(storage.data.has('k')).toBe(false);
  });
});
