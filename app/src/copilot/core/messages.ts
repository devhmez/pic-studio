// Chat messages, the summary of a proposal shown on its card, and the per-project persistence (localStorage):
// messages only — no usage figures — plus what is needed to resume the CLI conversation.
import { buildNetlist, type ComponentInstance, type Schematic } from '@pic/circuit';
import type { CopilotErrorKind, CopilotModel } from '../../host/bridge';
import type { ConversationState } from './turn';
import type { TurnUsage } from './usage';
import type { CodeStyle, ProjectState, VerifyReport } from './verify';

export type ProposalStatus = 'pending' | 'applied' | 'ignored' | 'undone';

export interface ProposalSummary {
  /** « D1 · LED rouge » */
  parts: string[];
  /** PIC pins wired in the proposed schematic (RA0…RB7). */
  pins: string[];
  clockMhz: number;
  circuitChanged: boolean;
  codeChanged: boolean;
  codeLines: number;
  /** Lines of the new code that are not in the current one. */
  changedLines: number;
  style: CodeStyle;
  tests: { description: string; passed: boolean; details: string[] }[];
  /** Problems still there after the automatic corrections (French). */
  issues: string[];
  warnings: string[];
}

export interface ProposalPayload {
  schematic: Schematic;
  source: string;
  /** Program model when the code is the prof-style rewrite (applied with setProgram). */
  program: unknown | null;
  clockHz: number;
  /** projectFingerprint of the proposal (the copilot is not re-sent a project that is exactly its proposal). */
  fingerprint: string;
  /** The copilot's latest message is exactly this proposal. */
  latest: boolean;
  /**
   * Which halves the answer proposes (absent in older saved proposals: both). Applying replaces only these: the other
   * half stays as the student has it now, not as it was when the request was sent.
   */
  circuit?: boolean;
  code?: boolean;
  /** projectFingerprint of the project when the request was sent (to tell the student it has changed since). */
  base?: string;
}

export interface ChatError {
  kind: CopilotErrorKind | 'unavailable' | 'enonce';
  message: string;
}

export interface ChatMessage {
  id: string;
  role: 'student' | 'copilot';
  text: string;
  /** ms since epoch */
  at: number;
  attachment?: { name: string; chars: number; truncated: boolean };
  questions?: string[];
  proposal?: { summary: ProposalSummary; status: ProposalStatus; payload?: ProposalPayload };
  /** Automatic corrections sent for this answer. */
  corrections?: number;
  /** Not persisted. */
  usage?: TurnUsage;
  error?: ChatError;
}

// ------------------------------------------------------------------------------------------------ summary

const COLOR_FR: Readonly<Record<string, string>> = { RED: 'rouge', GREEN: 'verte', BLUE: 'bleue', YELLOW: 'jaune' };
const SEG_FR: Readonly<Record<string, string>> = { RED: 'rouge', GREEN: 'vert', BLUE: 'bleu' };

export function partLabel(c: ComponentInstance): string | null {
  const name = c.ref || c.id;
  switch (c.kind) {
    case 'LED': return `${name} · LED ${COLOR_FR[String(c.props.color)] ?? ''}`.trim();
    case 'LOGICSTATE': return `${name} · interrupteur (LOGICSTATE)`;
    case 'BUTTON': return `${name} · bouton poussoir`;
    case 'RES': return c.value ? `${name} · résistance ${c.value} Ω` : `${name} · résistance`;
    case '7SEG-BCD': return `${name} · afficheur 7 segments BCD ${SEG_FR[String(c.props.color)] ?? ''}`.trim();
    case '7SEG-CC': return `${name} · afficheur 7 segments`;
    case 'TRAFFIC_LIGHTS': return `${name} · feux tricolores`;
    case 'TORCH_LDR': return `${name} · capteur de lumière (LDR)`;
    case 'CAP': return `${name} · condensateur ${c.value ?? ''}`.trim();
    case 'CRYSTAL': return `${name} · quartz ${c.value ?? ''}`.trim();
    default: return null;
  }
}

const PIN_ORDER = ['RA0', 'RA1', 'RA2', 'RA3', 'RA4/T0CKI', 'RB0/INT', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'];
const SHORT: Readonly<Record<string, string>> = { 'RA4/T0CKI': 'RA4', 'RB0/INT': 'RB0' };

export function wiredPins(s: Schematic): string[] {
  const pic = s.components.find((c) => c.kind === 'PIC16F84A');
  if (!pic) return [];
  const nl = buildNetlist(s);
  return PIN_ORDER.filter((p) => {
    const id = nl.pinToNet.get(`${pic.id}:${p}`);
    const net = id ? nl.nets.find((n) => n.id === id) : undefined;
    return !!net && net.pins.length > 1;
  }).map((p) => SHORT[p] ?? p);
}

const lines = (s: string) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l !== '');

export function summarize(report: VerifyReport, current: Pick<ProjectState, 'schematic' | 'source'>): ProposalSummary {
  const newLines = lines(report.source);
  const old = new Map<string, number>();
  for (const l of lines(current.source)) old.set(l, (old.get(l) ?? 0) + 1);
  let changed = 0;
  for (const l of newLines) {
    const n = old.get(l) ?? 0;
    if (n > 0) old.set(l, n - 1);
    else changed++;
  }
  const p = report.problems;
  return {
    parts: report.schematic.components.map(partLabel).filter((x): x is string => !!x),
    pins: wiredPins(report.schematic),
    clockMhz: report.clockHz / 1e6,
    circuitChanged: report.schematicFromAnswer,
    codeChanged: report.sourceFromAnswer && report.source.replace(/\r\n?/g, '\n').trim() !== current.source.replace(/\r\n?/g, '\n').trim(),
    codeLines: newLines.length,
    changedLines: changed,
    style: report.style,
    tests: report.tests.map((t) => ({ description: t.description, passed: t.passed, details: t.details })),
    issues: [...p.missing, ...p.circuit, ...p.compile, ...p.consistency],
    warnings: report.warnings,
  };
}

// ------------------------------------------------------------------------------------------------ persistence

export interface StoredConversation {
  version: 1;
  conversation: ConversationState;
  model: CopilotModel;
  messages: ChatMessage[];
  savedAt: number;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_PREFIX = 'pic-studio.copilot.v1:';
const MAX_MESSAGES = 80;

/**
 * Storage key of a project's conversation: its file, else its template, else the one unsaved project (renaming an
 * unsaved project keeps its conversation; saving it moves the conversation to the file).
 */
export function conversationKey(project: { fileName: string | null; templateId?: string }): string {
  if (project.fileName) return `${STORAGE_PREFIX}file:${project.fileName}`;
  if (project.templateId) return `${STORAGE_PREFIX}template:${project.templateId}`;
  return `${STORAGE_PREFIX}unsaved`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What is written: no usage, payload only on the last pending proposal. */
export function toStored(conversation: ConversationState, model: CopilotModel, messages: readonly ChatMessage[], now = Date.now()): StoredConversation {
  const kept = messages.slice(-MAX_MESSAGES);
  const lastPending = [...kept].reverse().find((m) => m.proposal?.status === 'pending' || m.proposal?.status === 'applied');
  return {
    version: 1,
    conversation,
    model,
    savedAt: now,
    messages: kept.map((m) => {
      const { usage: _usage, ...rest } = m;
      void _usage;
      if (!rest.proposal) return rest;
      const { payload, ...proposal } = rest.proposal;
      return { ...rest, proposal: m === lastPending && payload ? { ...proposal, payload } : proposal };
    }),
  };
}

export function saveConversation(storage: KeyValueStorage | null, key: string, data: StoredConversation): void {
  if (!storage) return;
  try {
    if (data.messages.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(data));
  } catch {
    // Quota or private mode: the conversation simply is not kept.
  }
}

/** Read back a stored conversation, dropping anything malformed. */
export function loadConversation(storage: KeyValueStorage | null, key: string): StoredConversation | null {
  if (!storage) return null;
  let raw: unknown;
  try {
    const text = storage.getItem(key);
    if (!text) return null;
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.conversation) || !Array.isArray(raw.messages)) return null;
  const c = raw.conversation;
  if (typeof c.sessionId !== 'string') return null;
  const conversation: ConversationState = {
    sessionId: c.sessionId,
    started: c.started === true,
    costBaseline: typeof c.costBaseline === 'number' && Number.isFinite(c.costBaseline) ? c.costBaseline : 0,
    appliedFingerprint: typeof c.appliedFingerprint === 'string' ? c.appliedFingerprint : null,
    ...(c.appliedRestyled === true ? { appliedRestyled: true } : {}),
  };
  const messages: ChatMessage[] = [];
  for (const m of raw.messages) {
    if (!isRecord(m) || (m.role !== 'student' && m.role !== 'copilot') || typeof m.text !== 'string' || typeof m.id !== 'string') continue;
    const msg: ChatMessage = { id: m.id, role: m.role, text: m.text, at: typeof m.at === 'number' ? m.at : 0 };
    if (isRecord(m.attachment) && typeof m.attachment.name === 'string') {
      msg.attachment = { name: m.attachment.name, chars: Number(m.attachment.chars) || 0, truncated: m.attachment.truncated === true };
    }
    if (Array.isArray(m.questions)) msg.questions = m.questions.filter((q): q is string => typeof q === 'string');
    if (isRecord(m.proposal) && isRecord(m.proposal.summary)) {
      const status = ['pending', 'applied', 'ignored', 'undone'].includes(String(m.proposal.status)) ? m.proposal.status as ProposalStatus : 'ignored';
      const payload = isRecord(m.proposal.payload) && isRecord(m.proposal.payload.schematic) && typeof m.proposal.payload.source === 'string'
        ? m.proposal.payload as unknown as ProposalPayload : undefined;
      // A pending proposal without its payload can no longer be applied.
      msg.proposal = { summary: m.proposal.summary as unknown as ProposalSummary, status: status === 'pending' && !payload ? 'ignored' : status, ...(payload ? { payload } : {}) };
    }
    if (typeof m.corrections === 'number') msg.corrections = m.corrections;
    if (isRecord(m.error) && typeof m.error.message === 'string') msg.error = { kind: (m.error.kind as ChatError['kind']) ?? 'process', message: m.error.message };
    messages.push(msg);
  }
  const model: CopilotModel = raw.model === 'sonnet' ? 'sonnet' : 'haiku';
  return { version: 1, conversation, model, messages, savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0 };
}

/** A few lines recalling the conversation (when a lost CLI session must be restarted). */
export function recapOf(messages: readonly ChatMessage[], max = 6): string {
  return messages.slice(-max).map((m) => `${m.role === 'student' ? 'Étudiant' : 'Copilote'} : ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
}
