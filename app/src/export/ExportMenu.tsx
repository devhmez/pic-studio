// Content of the toolbar's « Exporter » popover: one row per deliverable with its formats. The shell closes the
// popover after any button click; the exports then run (file dialog, print dialog) and report with a toast.
// The « Rendu du TP » row also holds the student's name and class (typing in them keeps the popover open).
import { memo, useId, type ReactNode } from 'react';
import { savesPdfDirectly } from '../host/print';
import { resolveChartSource } from '../organigramme/charts';
import { Icon, type IconName } from '../shell/icons';
import { useApp } from '../state/store';
import type { AppStore } from '../state/types';
import {
  exportCFile, exportCodeCapture, exportHex, exportOrganigramme, exportProjectFile, exportRenduPdf, exportSchematic,
  exportSchematicCapture, exportWiringSheet,
} from './actions';
import { setRenduPrefs, useRenduPrefs } from './renduPrefs';
import { startTraceRecording } from './traceHook';
import './export.css';

// The trace of the « Rendu du TP » must see every simulation from the start: this module loads with the toolbar.
startTraceRecording();

const selectHexState = (s: AppStore): 'ok' | 'stale' | 'error' =>
  s.compile.stale || !s.compile.result ? 'stale' : s.compile.result.ok ? 'ok' : 'error';

const selectHasChart = (s: AppStore): boolean => resolveChartSource(s.project, s.compile.result) !== null;

const selectChartCount = (s: AppStore): number => {
  const src = resolveChartSource(s.project, s.compile.result);
  return src ? 1 + src.program.functions.length : 0;
};

const selectLive = (s: AppStore): boolean => s.sim.status !== 'stopped' && s.sim.snapshot !== null;

interface Format {
  label: string;
  title: string;
  onClick(): void;
  disabled?: boolean;
  primary?: boolean;
}

interface RowProps {
  icon: IconName;
  title: string;
  detail: ReactNode;
  formats: Format[];
  /** Extra content under the row (the Rendu's fields). */
  children?: ReactNode;
  className?: string;
}

function Row({ icon, title, detail, formats, children, className = '' }: RowProps) {
  return (
    <li className={`xp-row ${className}`}>
      <span className="xp-icon" aria-hidden="true"><Icon name={icon} size={15} /></span>
      <span className="xp-text">
        <span className="xp-title">{title}</span>
        <span className="xp-detail">{detail}</span>
      </span>
      <span className="xp-formats" role="group" aria-label={title}>
        {formats.map((f) => (
          <button
            key={f.label}
            type="button"
            className={`xp-format${f.primary ? ' is-primary' : ''}`}
            onClick={f.onClick}
            disabled={f.disabled}
            title={f.title}
            aria-label={f.title}
          >
            {f.label}
          </button>
        ))}
      </span>
      {children && <div className="xp-extra">{children}</div>}
    </li>
  );
}

/** Name, class and trace option of the Rendu (remembered on this Mac). */
function RenduFields() {
  const prefs = useRenduPrefs();
  const id = useId();
  return (
    <div className="xp-fields">
      <label className="xp-field xp-field-name" htmlFor={`${id}-name`}>
        <span>Nom et prénom</span>
        <input
          id={`${id}-name`}
          type="text"
          value={prefs.student}
          maxLength={120}
          placeholder="Vide : ligne à compléter"
          aria-label="Nom et prénom (en-tête du rendu)"
          autoComplete="name"
          spellCheck={false}
          onChange={(e) => setRenduPrefs({ student: e.target.value })}
        />
      </label>
      <label className="xp-field xp-field-class" htmlFor={`${id}-class`}>
        <span>Classe</span>
        <input
          id={`${id}-class`}
          type="text"
          value={prefs.className}
          maxLength={40}
          placeholder="ex. 2A12"
          aria-label="Classe (en-tête du rendu)"
          spellCheck={false}
          onChange={(e) => setRenduPrefs({ className: e.target.value })}
        />
      </label>
      <label className="xp-check">
        <input
          type="checkbox"
          checked={prefs.includeTrace}
          aria-label="Ajouter la trace de la simulation au rendu"
          onChange={(e) => setRenduPrefs({ includeTrace: e.target.checked })}
        />
        <span>Ajouter la trace de la simulation (entrées réglées, réaction des sorties)</span>
      </label>
    </div>
  );
}

export const ExportMenu = memo(function ExportMenu() {
  const hex = useApp(selectHexState);
  const hasChart = useApp(selectHasChart);
  const charts = useApp(selectChartCount);
  const live = useApp(selectLive);

  const several = charts > 1;
  const directPdf = savesPdfDirectly();
  return (
    <div className="xp-menu">
      <p className="xp-heading" id="xp-heading">Exporter</p>
      <ul className="xp-list" aria-labelledby="xp-heading">
        <Row
          icon="book"
          className="xp-rendu"
          title="Rendu du TP"
          detail={live
            ? 'Organigramme, code, schéma en simulation (état actuel) et trace, en A4'
            : 'Organigramme, code, schéma et trace en A4 — lancez la simulation avant pour montrer les LEDs'}
          formats={[{
            label: 'PDF',
            primary: true,
            title: directPdf ? 'Créer le rendu du TP en PDF (A4)' : 'Créer le rendu du TP (fenêtre d’impression : « Enregistrer au format PDF »)',
            onClick: () => void exportRenduPdf(),
          }]}
        >
          <RenduFields />
        </Row>
        <Row
          icon="fit"
          title="Captures"
          detail={live ? 'Images PNG 300 dpi ; le schéma avec l’état actuel de la simulation' : 'Images PNG 300 dpi pour Word ; le schéma en simulation après ▶'}
          formats={[
            { label: 'Code', title: 'Capture du code (PNG)', onClick: () => void exportCodeCapture() },
            { label: 'Schéma', title: 'Capture du schéma en simulation (PNG)', onClick: () => void exportSchematicCapture() },
          ]}
        />
        <Row
          icon="save"
          title="Code MikroC"
          detail="Windows-1252 et CRLF : s’ouvre dans MikroC PRO for PIC"
          formats={[{ label: '.c', title: 'Enregistrer le code C (.c)', onClick: () => void exportCFile() }]}
        />
        <Row
          icon="stepInstr"
          title="Programme compilé"
          detail={hex === 'error' ? 'Le code ne compile pas encore' : 'À charger dans le PIC sous ISIS (Program File)'}
          formats={[{ label: '.hex', title: 'Enregistrer le fichier HEX (.hex)', onClick: () => void exportHex(), disabled: hex === 'error' }]}
        />
        <Row
          icon="templates"
          title="Organigramme"
          detail={!hasChart ? 'Pas encore d’organigramme' : several ? 'Tous les organigrammes côte à côte' : 'PNG 300 dpi pour Word, PDF, SVG'}
          formats={[
            { label: 'PNG', title: 'Organigramme en image PNG (300 dpi)', onClick: () => void exportOrganigramme('png'), disabled: !hasChart },
            { label: 'PDF', title: directPdf ? 'Organigramme en PDF (A4)' : 'Organigramme en PDF (fenêtre d’impression)', onClick: () => void exportOrganigramme('pdf'), disabled: !hasChart },
            { label: 'SVG', title: 'Organigramme en SVG (vectoriel)', onClick: () => void exportOrganigramme('svg'), disabled: !hasChart },
          ]}
        />
        <Row
          icon="wire"
          title="Schéma"
          detail={live ? 'Avec l’état actuel de la simulation (LED, broches)' : 'Couleurs ISIS, sans la grille'}
          formats={[
            { label: 'PNG', title: 'Schéma en image PNG (300 dpi)', onClick: () => void exportSchematic('png') },
            { label: 'SVG', title: 'Schéma en SVG (vectoriel)', onClick: () => void exportSchematic('svg') },
          ]}
        />
        <Row
          icon="search"
          title="Fiche de câblage"
          detail="Composants et broche par broche, pour refaire le montage dans ISIS"
          formats={[
            directPdf
              ? { label: 'PDF', title: 'Enregistrer la fiche de câblage en PDF (A4, à imprimer)', onClick: () => void exportWiringSheet('print') }
              : { label: 'Imprimer', title: 'Imprimer la fiche de câblage (ou l’enregistrer en PDF)', onClick: () => void exportWiringSheet('print') },
            { label: 'HTML', title: 'Enregistrer la fiche de câblage (.html)', onClick: () => void exportWiringSheet('html') },
          ]}
        />
        <Row
          icon="folder"
          title="Projet PIC Studio"
          detail="Schéma, code, programme et organigramme dans un seul fichier"
          formats={[{ label: '.picproj', title: 'Enregistrer le projet sous… (.picproj)', onClick: () => void exportProjectFile() }]}
        />
      </ul>
    </div>
  );
});
