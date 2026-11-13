// "Code" panel: CodeMirror 6 editor bound to project.source (MikroC highlighting, French diagnostics, breakpoints,
// current execution line, autocomplete) with a header (origin badge, encoding chip, font size) and a problems strip.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
} from '@codemirror/view';
import type { CompileResultEx, Diagnostic as CompilerDiagnostic } from '@pic/compiler';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { handleDebugKey, SHORTCUTS } from '../debug/commands';
import { formatClock } from '../debug/format';
import { CheckIcon, ErrorIcon, InfoIcon, MinusIcon, PlusIcon, WarningIcon } from '../debug/icons';
import { breakpointLines, breakpointTogglesForLine } from '../debug/listing';
import { selectPausedLine } from '../debug/running';
import { HeaderActions } from '../debug/PanelChrome';
import { readPref, useElementWidth, writePref } from '../debug/useElementWidth';
import { getApp, useApp } from '../state/store';
import { completionDataFrom, EMPTY_COMPLETION_DATA, type CompletionData } from './completionData';
import { picCompletionSource } from './completions';
import { debugGutter, execLinePos, setBreakpointLines, setDebugLines, toggleBreakpointAtCursor, type DebugLines } from './debugGutter';
import { countDiagnostics, countsLabel, offsetOf, SEVERITY_LABEL, sortForStrip, toEditorDiagnostics } from './diagnostics';
import { mikroC } from './mikroc';
import '../debug/chrome.css';
import './CodePanel.css';

/** Delay between the last keystroke and the automatic build. */
export const AUTO_BUILD_DELAY_MS = 400;
const FONT_MIN = 10;
const FONT_MAX = 24;
const FONT_DEFAULT = 13;
const FONT_PREF = 'picstudio.code.fontSize';
const FONT_SIZES = Array.from({ length: FONT_MAX - FONT_MIN + 1 }, (_, i) => String(FONT_MIN + i));

const EMPTY_DIAGNOSTICS: readonly CompilerDiagnostic[] = [];
const EMPTY_LINES: DebugLines = { lineToAddr: new Map(), breakpointLines: new Set(), execLine: null };

/**
 * Toggle the breakpoint(s) of C line `line`. `line` comes from a gutter marker, i.e. from the build the markers were
 * made from (`lines`), which stays the last successful one while the code does not compile.
 */
function toggleLine(lines: CompileResultEx | null, line: number): void {
  const app = getApp();
  if (!lines) return;
  for (const addr of breakpointTogglesForLine(line, lines.lineToAddr, lines.addrToLine, app.sim.breakpoints)) app.toggleBreakpoint(addr);
}

const normalizeEol = (s: string) => s.replace(/\r\n?/g, '\n');

export function CodePanel() {
  const source = useApp((s) => s.project.source);
  const origin = useApp((s) => s.project.sourceOrigin);
  const clockHz = useApp((s) => s.project.clockHz);
  const result = useApp((s) => s.compile.result);
  const stale = useApp((s) => s.compile.stale);
  const breakpoints = useApp((s) => s.sim.breakpoints);
  // Mapped onto the edited text when the core still runs the previous program.
  const execLine = useApp(selectPausedLine);
  const pausedPc = useApp((s) => (s.sim.status === 'paused' ? s.sim.debug?.pc ?? null : null));

  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  /** The shell's header also holds the title and the maximize button: trim our actions in narrow panels. */
  const compact = width > 0 && width < 520;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Last source value exchanged with the store (pushed by typing or loaded from it). */
  const syncedRef = useRef(source);
  const buildTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const completionRef = useRef<CompletionData>(EMPTY_COMPLETION_DATA);
  const linesRef = useRef<DebugLines>(EMPTY_LINES);
  /** Build the gutter markers come from: the last one that compiled (line numbers stay meaningful while typing). */
  const markersBuildRef = useRef<CompileResultEx | null>(null);
  const diagsRef = useRef<readonly CompilerDiagnostic[]>(EMPTY_DIAGNOSTICS);

  const [fontSize, setFontSize] = useState(() => Number(readPref(FONT_PREF, FONT_SIZES, String(FONT_DEFAULT))));
  const changeFont = useCallback((delta: number) => {
    setFontSize((f) => {
      const next = delta === 0 ? FONT_DEFAULT : Math.min(FONT_MAX, Math.max(FONT_MIN, f + delta));
      writePref(FONT_PREF, String(next));
      return next;
    });
  }, []);

  // ---- editor lifecycle (created once; external text loads replace the whole state) -------------------------

  /** (Re)start the debounced auto-build. */
  const scheduleBuild = useCallback(() => {
    clearTimeout(buildTimer.current);
    buildTimer.current = setTimeout(() => {
      if (getApp().compile.stale || !getApp().compile.result) getApp().build();
    }, AUTO_BUILD_DELAY_MS);
  }, []);

  const extensions = useMemo<Extension[]>(() => {
    const onToggleLine = (line: number) => toggleLine(markersBuildRef.current, line);
    return [
      lineNumbers(),
      debugGutter(onToggleLine),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [picCompletionSource(completionRef)], activateOnTypingDelay: 120, icons: false }),
      highlightActiveLine(),
      highlightSelectionMatches(),
      mikroC(),
      keymap.of([
        { key: SHORTCUTS.breakpoint.keys[0], run: (v) => toggleBreakpointAtCursor(v, onToggleLine) },
        { key: 'Mod-=', run: () => { changeFont(1); return true; } },
        { key: 'Mod-+', run: () => { changeFont(1); return true; } },
        { key: 'Mod--', run: () => { changeFont(-1); return true; } },
        { key: 'Mod-0', run: () => { changeFont(0); return true; } },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      EditorView.contentAttributes.of({
        'aria-label': 'Éditeur du programme C (MikroC)',
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
      }),
      EditorView.updateListener.of((u) => {
        // Only typing reaches here: loads from the store go through view.setState(), which notifies no listener.
        if (!u.docChanged) return;
        const text = u.state.doc.toString();
        syncedRef.current = text;
        getApp().setSource(text);
        scheduleBuild();
      }),
    ];
  }, [changeFont, scheduleBuild]);

  /** Push the latest derived decorations (diagnostics, breakpoints, exec line) into the view. */
  const pushDiagnostics = useCallback((view: EditorView) => {
    const doc = view.state.doc;
    const cm: CmDiagnostic[] = toEditorDiagnostics(doc, diagsRef.current, (a, b) => view.state.sliceDoc(a, b));
    view.dispatch(setDiagnostics(view.state, cm));
  }, []);
  const pushLines = useCallback((view: EditorView) => {
    view.dispatch({ effects: setDebugLines.of(linesRef.current) });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = getApp().project.source;
    syncedRef.current = initial;
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: initial, extensions }) });
    viewRef.current = view;
    pushDiagnostics(view);
    pushLines(view);
    return () => {
      clearTimeout(buildTimer.current);
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions, pushDiagnostics, pushLines]);

  // Text changed in the store by something other than typing (template, assistant, file): load it fresh.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || source === syncedRef.current) return;
    syncedRef.current = source;
    if (normalizeEol(source) === view.state.doc.toString()) return;
    // Fresh state: a new text gets its own undo history (undo must not resurrect another program).
    view.setState(EditorState.create({ doc: source, extensions }));
    pushDiagnostics(view);
    const r = getApp().compile.result;
    if (!r?.ok || r.source !== source) {
      markersBuildRef.current = null;
      linesRef.current = EMPTY_LINES;
    }
    pushLines(view);
  }, [source, extensions, pushDiagnostics, pushLines]);

  // Anything that leaves the build stale (typing, assistant regeneration, clock change) gets rebuilt shortly after.
  useEffect(() => {
    if (stale || !result) scheduleBuild();
  }, [stale, result, scheduleBuild]);

  // Diagnostics and autocomplete data follow the compile result.
  useEffect(() => {
    diagsRef.current = result?.diagnostics ?? EMPTY_DIAGNOSTICS;
    if (result?.ast) completionRef.current = completionDataFrom(result);
    const view = viewRef.current;
    if (view) pushDiagnostics(view);
  }, [result, pushDiagnostics]);

  // Breakpoint dots and the execution line. While the code does not compile, the markers of the last good build
  // stay (CodeMirror maps them through the edits) instead of disappearing.
  useEffect(() => {
    const view = viewRef.current;
    const kept = markersBuildRef.current;
    if (result && !result.ok && kept) {
      view?.dispatch({ effects: setBreakpointLines.of(breakpointLines(breakpoints, kept.addrToLine)) });
      return;
    }
    markersBuildRef.current = result?.ok ? result : null;
    linesRef.current = result?.ok
      ? { lineToAddr: result.lineToAddr, breakpointLines: breakpointLines(breakpoints, result.addrToLine), execLine }
      : EMPTY_LINES;
    if (view) pushLines(view);
  }, [result, breakpoints, execLine, pushLines]);

  // Follow the execution line after each step (not when breakpoints or diagnostics change).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pausedPc === null || execLine === null) return;
    const pos = execLinePos(view.state);
    if (pos !== null) view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 64 }) });
  }, [pausedPc, execLine]);

  // Font size changes the line height: let CodeMirror re-measure.
  useEffect(() => { viewRef.current?.requestMeasure(); }, [fontSize]);

  const goTo = useCallback((d: CompilerDiagnostic) => {
    const view = viewRef.current;
    if (!view) return;
    const pos = offsetOf(view.state.doc, d.line, d.col);
    view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    view.focus();
  }, []);

  // Fallback for the debugger keys (F5, F6, F7, F8...) when the panel is hosted without the shell's global shortcuts.
  const onPanelKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => { handleDebugKey(e); }, []);

  const style = { '--code-font-size': `${fontSize}px` } as CSSProperties;

  return (
    <div ref={rootRef} className="pcx-panel code-panel" style={style} onKeyDown={onPanelKeyDown}>
      <HeaderActions title="Code C">
        <OriginBadge origin={origin} compact={compact} />
        <span className="pcx-spacer" />
        {!compact && (
          <span
            className="pcx-chip pcx-mono"
            title="À l'export, le fichier .c est enregistré en Windows-1252 avec des fins de ligne CRLF, comme MikroC : les accents (é, à) s'ouvrent correctement."
          >
            CP1252 · CRLF
          </span>
        )}
        {!compact && <span className="pcx-sep" aria-hidden="true" />}
        <div className="pcx-group" role="group" aria-label="Taille du texte">
          <button
            type="button"
            className="pcx-iconbtn"
            onClick={() => changeFont(-1)}
            disabled={fontSize <= FONT_MIN}
            aria-label="Réduire la taille du texte"
            title="Réduire la taille du texte (⌘−)"
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            className="pcx-iconbtn code-fontsize pcx-mono"
            onClick={() => changeFont(0)}
            aria-label={`Taille du texte : ${fontSize} points. Rétablir la taille par défaut`}
            title="Taille par défaut (⌘0)"
          >
            {fontSize}
          </button>
          <button
            type="button"
            className="pcx-iconbtn"
            onClick={() => changeFont(1)}
            disabled={fontSize >= FONT_MAX}
            aria-label="Agrandir la taille du texte"
            title="Agrandir la taille du texte (⌘+)"
          >
            <PlusIcon />
          </button>
        </div>
      </HeaderActions>

      <div className="code-editor" ref={hostRef} />

      <ProblemsStrip
        diagnostics={result?.diagnostics ?? EMPTY_DIAGNOSTICS}
        ok={result?.ok ?? null}
        stale={stale}
        rom={result?.ok ? result.usage.rom : null}
        ram={result?.ok ? result.usage.ram : null}
        clockHz={clockHz}
        onSelect={goTo}
      />
    </div>
  );
}

const OriginBadge = memo(function OriginBadge({ origin, compact }: { origin: 'generated' | 'manual'; compact: boolean }) {
  return origin === 'generated' ? (
    <span
      className="pcx-chip is-accent"
      title="Ce code a été écrit par l'assistant à partir de votre description, dans le style du cours. Dès que vous le modifiez, il passe en « Modifié à la main »."
    >
      {compact ? 'Assistant' : 'Généré par l\u2019assistant'}
    </span>
  ) : (
    <span className="pcx-chip" title="Ce code a été saisi ou modifié à la main.">
      {compact ? 'Manuel' : 'Modifié à la main'}
    </span>
  );
});

interface ProblemsStripProps {
  diagnostics: readonly CompilerDiagnostic[];
  /** null before the first build. */
  ok: boolean | null;
  stale: boolean;
  rom: number | null;
  ram: number | null;
  clockHz: number;
  onSelect(d: CompilerDiagnostic): void;
}

const SEVERITY_ICON = { error: ErrorIcon, warning: WarningIcon, info: InfoIcon } as const;

const ProblemsStrip = memo(function ProblemsStrip({ diagnostics, ok, stale, rom, ram, clockHz, onSelect }: ProblemsStripProps) {
  const sorted = useMemo(() => sortForStrip(diagnostics), [diagnostics]);
  const counts = useMemo(() => countDiagnostics(diagnostics), [diagnostics]);
  const label = countsLabel(counts);
  // The selected problem is shown in full; the others stay on one line so the editor keeps its room.
  const [openKey, setOpenKey] = useState<string | null>(null);

  let status: ReactNode;
  if (ok === null) status = <span className="code-status is-pending">Compilation…</span>;
  else if (!ok) status = <span className="code-status is-error"><ErrorIcon />{label || 'La compilation a échoué'}</span>;
  else status = <span className="code-status is-ok"><CheckIcon />Compilé{label ? <span className="code-status-count">{label}</span> : null}</span>;

  return (
    <div className={`code-problems${stale ? ' is-stale' : ''}`} aria-label="Problèmes de compilation">
      <div className="code-problems-head" role="status" aria-live="polite">
        {status}
        {stale && ok !== null && <span className="code-status-detail">mise à jour…</span>}
        <span className="pcx-spacer" />
        {rom !== null && (
          <span className="code-status-detail pcx-mono pcx-hide-xnarrow" title="Mots de mémoire programme utilisés (sur 1024)">{rom} / 1024 mots</span>
        )}
        {ram !== null && (
          <span className="code-status-detail pcx-mono pcx-hide-narrow" title="Octets de RAM utilisés (registres 0x0C–0x4F)">RAM {ram} / 68</span>
        )}
        <span
          className="code-status-detail pcx-hide-narrow"
          title="Horloge du PIC : Delay_ms est calculé pour cette fréquence, la simulation utilise la même."
        >
          {formatClock(clockHz)}
        </span>
      </div>
      {sorted.length > 0 && (
        <ul className="code-problems-list">
          {sorted.map((d, i) => {
            const Icon = SEVERITY_ICON[d.severity];
            const key = `${d.line}:${d.col}:${d.code}:${i}`;
            const open = key === openKey;
            return (
              <li key={key}>
                <button
                  type="button"
                  className={`code-problem is-${d.severity}${open ? ' is-open' : ''}`}
                  onClick={() => { setOpenKey(open ? null : key); onSelect(d); }}
                  title={`${SEVERITY_LABEL[d.severity]} (${d.code}) — ${d.message}`}
                  aria-expanded={open}
                  aria-label={`${SEVERITY_LABEL[d.severity]} ligne ${d.line}, colonne ${d.col} : ${d.message}`}
                >
                  <Icon className="code-problem-icon" />
                  <span className="code-problem-pos pcx-mono">{d.line}:{d.col}</span>
                  <span className="code-problem-msg">{d.message}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
