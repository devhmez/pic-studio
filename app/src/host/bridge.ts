// Contract between the renderer and the Electron main process, exposed by electron/preload.ts as
// `window.picStudio`. In the browser (npm run dev) `window.picStudio` is undefined and the app falls back
// to the browser platform; the copilot then shows « Disponible dans l'application Mac ».
import type { OpenedFile, OpenOptions, SaveOptions } from '../platform';

/** Native file dialogs and printing (implements the same shape as Platform in ../platform.ts, plus PDF). */
export interface HostPlatform {
  openProjectFile(options?: OpenOptions): Promise<OpenedFile | null>;
  saveFile(name: string, data: string | Uint8Array, mime: string, options?: SaveOptions): Promise<string | null>;
  /** Render a self-contained HTML document to PDF (Electron printToPDF) and ask where to save it. Resolves the saved name or null. */
  savePdf(name: string, html: string, options?: { landscape?: boolean }): Promise<string | null>;
  /** Open a file (e.g. an énoncé PDF/DOCX) for the copilot. Resolves null when cancelled. */
  openDocument(accept: string[]): Promise<OpenedFile | null>;
}

export type CopilotModel = 'haiku' | 'sonnet';

export interface CopilotStatus {
  /** True when the `claude` CLI was found and is logged in with a claude.ai subscription. */
  available: boolean;
  cliPath?: string;
  cliVersion?: string;
  loggedIn?: boolean;
  /** e.g. 'max', 'pro' (from `claude auth status`). */
  subscription?: string;
  /** French explanation when unavailable. */
  error?: string;
}

export interface CopilotRunRequest {
  /** Unique per request, used to cancel. */
  requestId: string;
  /** Conversation id (UUID). First turn: passed with --session-id; later turns: --resume. */
  sessionId: string;
  resume: boolean;
  /** The user turn (French request + context), plain text. */
  prompt: string;
  /** Full system prompt (replaces Claude Code's default prompt). Only sent on the first turn of a session. */
  systemPrompt: string;
  /** JSON Schema (draft-07) for the structured answer (--json-schema). */
  jsonSchema: object;
  model: CopilotModel;
  /** Default 3 (structured output consumes one turn). */
  maxTurns?: number;
  /** Default 180 000 ms; the main process sends SIGINT then SIGTERM when exceeded. */
  timeoutMs?: number;
}

export interface CopilotUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** total_cost_usd from the CLI: an API-equivalent estimate, cumulative for the whole session. */
  sessionCostUsd: number;
  /** Actual model id reported by the CLI (modelUsage key). */
  model?: string;
  durationMs: number;
}

export type CopilotErrorKind =
  | 'not-installed' | 'not-logged-in' | 'usage-limit' | 'timeout' | 'cancelled' | 'schema' | 'process';

export interface CopilotRunResult {
  requestId: string;
  ok: boolean;
  sessionId: string;
  /** The schema-valid object (CLI `structured_output`). */
  structuredOutput?: unknown;
  /** CLI `result` text (fallback / diagnostics). */
  resultText?: string;
  usage?: CopilotUsage;
  error?: { kind: CopilotErrorKind; message: string };
}

export interface CopilotBridge {
  status(): Promise<CopilotStatus>;
  run(request: CopilotRunRequest): Promise<CopilotRunResult>;
  cancel(requestId: string): Promise<void>;
}

export interface PicStudioHost {
  platform: HostPlatform;
  copilot: CopilotBridge;
  /** 'darwin' etc. */
  os: string;
  appVersion: string;
}

declare global {
  interface Window {
    picStudio?: PicStudioHost;
  }
}

export function getHost(): PicStudioHost | undefined {
  return typeof window === 'undefined' ? undefined : window.picStudio;
}
