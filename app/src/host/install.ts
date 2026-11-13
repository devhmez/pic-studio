// Start-up glue for the Mac app (called from ../main.tsx). In the browser (npm run dev) window.picStudio is
// undefined and nothing changes. Inside PIC Studio.app it:
//   - switches files to the native dialogs (setPlatform) — PDF exports use them through ./print.ts;
//   - marks <html class="is-electron"> for ./electron.css (toolbar under the traffic lights, window dragging);
//   - runs the menu-bar commands (./commands.ts), follows full screen and mirrors the theme to the window;
//   - tells the main process when the page is up (and runs the smoke checks of the packaging test).
import { createHostPlatform, setPlatform } from '../platform';
import { appStore } from '../state/store';
import { getHost } from './bridge';
import { runShellCommand } from './commands';
import type { AppState } from '../state/types';
import type { DrawerState, PicStudioShell, RendererReadyInfo } from './shell';
import './electron.css';

export interface HostInstall {
  shell: PicStudioShell | null;
  /** Content-Security-Policy violations seen since start-up (reported by the smoke test). */
  cspViolations: string[];
}

let installed: HostInstall | null = null;

const windowTitle = (projectName: string): string => (projectName.trim() ? `${projectName.trim()} — PIC Studio` : 'PIC Studio');

const drawersOf = ({ ui }: AppState): DrawerState => ({ assistant: ui.assistantOpen, learn: ui.learnOpen, copilot: ui.copilotOpen });

/** Wire the page to the Mac app. Returns null in the browser. Safe to call more than once. */
export function installHost(): HostInstall | null {
  if (installed) return installed;
  const host = getHost();
  if (!host) return null;

  setPlatform(createHostPlatform(host.platform));
  const root = document.documentElement;
  root.classList.add('is-electron');
  if (host.os === 'darwin') root.classList.add('is-mac-app');

  const cspViolations: string[] = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    if (cspViolations.length < 20) cspViolations.push(`${e.effectiveDirective} ${e.blockedURI || '(inline)'}`);
  });

  const shell = window.picStudioShell ?? null;
  if (shell) {
    // French native boxes instead of Electron's English « OK / Cancel » (projectFiles.ts, debug/commands.ts…).
    window.confirm = (message?: string) => shell.confirm(String(message ?? ''));
    window.alert = (message?: unknown) => shell.alert(String(message ?? ''));
    shell.onCommand((command) => void runShellCommand(command));
    shell.onFullScreen((fullScreen) => root.classList.toggle('is-fullscreen', fullScreen));
    const state = appStore.getState();
    shell.setTheme(state.ui.theme);
    shell.setEdited(state.dirty);
    shell.setDrawers(drawersOf(state));
    document.title = windowTitle(state.project.name);
    appStore.subscribe((s, prev) => {
      if (s.ui.theme !== prev.ui.theme) shell.setTheme(s.ui.theme);
      if (s.dirty !== prev.dirty) shell.setEdited(s.dirty);
      if (s.ui.assistantOpen !== prev.ui.assistantOpen || s.ui.learnOpen !== prev.ui.learnOpen || s.ui.copilotOpen !== prev.ui.copilotOpen) {
        shell.setDrawers(drawersOf(s));
      }
      // The window title (hidden in the toolbar, shown by Mission Control and the « Fenêtre » menu).
      if (s.project.name !== prev.project.name) document.title = windowTitle(s.project.name);
    });
  }
  installed = { shell, cspViolations };
  return installed;
}

/** After the first render: tell the main process the page is ready (it then delivers queued menu commands). */
export function announceRendererReady(): void {
  const current = installed;
  if (!current?.shell) return;
  const { shell, cspViolations } = current;
  // Two frames: React has committed and the browser has painted once.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const info: RendererReadyInfo = {
      href: location.href,
      hostPlatform: true,
      renderMs: Math.round(performance.now()),
    };
    if (!shell.smoke) {
      shell.rendererReady(info);
      return;
    }
    import('./smoke')
      .then(({ runSmokeChecks }) => runSmokeChecks())
      .then(
        (checks) => shell.rendererReady({ ...info, ...checks, cspViolations: [...cspViolations] }),
        (e: unknown) => shell.rendererReady({ ...info, detail: `contrôles : ${e instanceof Error ? e.message : String(e)}`, cspViolations: [...cspViolations] }),
      );
  }));
}
