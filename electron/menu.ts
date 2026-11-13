// French application menu. File/view commands are forwarded to the renderer (app/src/host/install.ts), which
// already implements them for the toolbar and the keyboard shortcuts; editing and window items use native roles,
// except Annuler / Rétablir, which also reach the schematic's own history.
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { DRAWER_COMMANDS, type DrawerState, type ShellCommand } from '../app/src/host/shell';

export interface MenuOptions {
  /** Forward a command to the renderer of the focused window (creating the window if needed). */
  send(command: ShellCommand): void;
  /**
   * Annuler / Rétablir: the native editing command (what the 'undo' / 'redo' roles do, for text fields and the code
   * editor), then the same command to the page for the schematic, whose history lives in the page.
   */
  edit(command: 'undo' | 'redo'): void;
  /** Show « Recharger » and the developer tools (dev builds, PIC_STUDIO_DEVTOOLS=1). */
  developer: boolean;
}

/** Check marks of the drawer items of « Affichage », as reported by the page (only one drawer is open at a time). */
export function showDrawers(menu: Menu | null, drawers: DrawerState): void {
  for (const [drawer, id] of Object.entries(DRAWER_COMMANDS) as [keyof DrawerState, string][]) {
    const item = menu?.getMenuItemById(id);
    if (item) item.checked = drawers[drawer];
  }
}

export function buildMenu({ send, edit, developer }: MenuOptions): Menu {
  const name = app.getName();
  // Menu items forward to the renderer. Their shortcuts (⌘N, ⌘O, ⌘S, ⇧⌘S, ⌘1–⌘4) are already handled by the
  // page itself (app/src/shell/shortcuts.ts, AZERTY-aware): the menu only displays them (registerAccelerator:
  // false), so a key press never runs the command twice.
  const command = (label: string, cmd: ShellCommand, accelerator?: string): MenuItemConstructorOptions =>
    ({ label, accelerator, registerAccelerator: accelerator ? false : undefined, click: () => send(cmd) });
  // Drawers toggle: a check mark shows the open one (the page reports its state, see showDrawers).
  const drawer = (label: string, cmd: ShellCommand): MenuItemConstructorOptions =>
    ({ label, id: cmd, type: 'checkbox', checked: false, click: () => send(cmd) });

  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { label: `À propos de ${name}`, role: 'about' },
        { type: 'separator' },
        { label: 'Services', role: 'services' },
        { type: 'separator' },
        { label: `Masquer ${name}`, role: 'hide' },
        { label: 'Masquer les autres', role: 'hideOthers' },
        { label: 'Tout afficher', role: 'unhide' },
        { type: 'separator' },
        { label: `Quitter ${name}`, role: 'quit' },
      ],
    },
    {
      label: 'Fichier',
      submenu: [
        command('Nouveau projet', 'new', 'CmdOrCtrl+N'),
        command('Ouvrir…', 'open', 'CmdOrCtrl+O'),
        {
          label: 'Ouvrir un élément récent',
          role: 'recentDocuments',
          submenu: [{ label: 'Effacer le menu', role: 'clearRecentDocuments' }],
        },
        command('Modèles de TP…', 'templates'),
        { type: 'separator' },
        command('Enregistrer', 'save', 'CmdOrCtrl+S'),
        command('Enregistrer sous…', 'saveAs', 'Shift+CmdOrCtrl+S'),
        { type: 'separator' },
        {
          label: 'Exporter',
          submenu: [
            command('Rendu du TP en PDF…', 'export:rendu-pdf'),
            { type: 'separator' },
            command('Code C pour MikroC (.c)…', 'export:c'),
            command('Programme compilé (.hex)…', 'export:hex'),
            command('Capture du code (PNG)…', 'export:code-png'),
            { type: 'separator' },
            command('Organigramme en PDF…', 'export:organigramme-pdf'),
            command('Organigramme en image PNG…', 'export:organigramme-png'),
            { type: 'separator' },
            command('Schéma en image PNG…', 'export:schematic-png'),
            command('Capture du schéma en simulation (PNG)…', 'export:schematic-capture'),
            command('Fiche de câblage en PDF…', 'export:wiring-pdf'),
          ],
        },
        { type: 'separator' },
        { label: 'Fermer la fenêtre', role: 'close' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        // A key press handled by the page (code editor, schematic) never reaches these items: macOS gives the
        // page the first go at ⌘Z, and only an unhandled one (e.g. in a text field) comes back to the menu.
        { label: 'Annuler', accelerator: 'CmdOrCtrl+Z', click: () => edit('undo') },
        { label: 'Rétablir', accelerator: 'Shift+CmdOrCtrl+Z', click: () => edit('redo') },
        { type: 'separator' },
        { label: 'Couper', role: 'cut' },
        { label: 'Copier', role: 'copy' },
        { label: 'Coller', role: 'paste' },
        { label: 'Coller et conserver le style', role: 'pasteAndMatchStyle' },
        { label: 'Supprimer', role: 'delete' },
        { label: 'Tout sélectionner', role: 'selectAll' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        command('Schéma', 'panel:schema', 'CmdOrCtrl+1'),
        command('Code C', 'panel:code', 'CmdOrCtrl+2'),
        command('Assembleur / registres', 'panel:asm', 'CmdOrCtrl+3'),
        command('Organigramme', 'panel:organigramme', 'CmdOrCtrl+4'),
        { type: 'separator' },
        drawer('Assistant', DRAWER_COMMANDS.assistant),
        drawer('Copilote', DRAWER_COMMANDS.copilot),
        drawer('Comprendre', DRAWER_COMMANDS.learn),
        { type: 'separator' },
        { label: 'Taille réelle', role: 'resetZoom' },
        { label: 'Agrandir le texte', role: 'zoomIn' },
        { label: 'Réduire le texte', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Plein écran', role: 'togglefullscreen' },
        ...(developer
          ? ([
            { type: 'separator' },
            { label: 'Recharger', role: 'reload' },
            { label: 'Outils de développement', role: 'toggleDevTools' },
          ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Fenêtre',
      role: 'window',
      submenu: [
        { label: 'Placer dans le Dock', role: 'minimize' },
        { label: 'Réduire / agrandir', role: 'zoom' },
        { type: 'separator' },
        { label: 'Tout ramener au premier plan', role: 'front' },
      ],
    },
    {
      label: 'Aide',
      role: 'help',
      submenu: [
        command('Comprendre le PIC16F84A', 'drawer:learn:open'),
        command('Choisir un modèle de TP…', 'templates'),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
