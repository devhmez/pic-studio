// « Modèles de TP » dialog content (the shell provides the modal frame, Escape and the backdrop): the course TPs
// grouped by chapter, each with a thumbnail of its circuit, plus « Projet vide ». Opening a template replaces the
// project, so unsaved work asks first (save, replace or cancel).
import { memo, useMemo, useState, type KeyboardEvent } from 'react';
import { notify } from '../shell/toast';
import { Icon } from '../shell/icons';
import { saveProject } from '../shell/projectFiles';
import { appStore, getApp, useApp, type TemplateEntry } from '../state/store';
import { groupTemplates, schematicPreviewUrl } from './groups';
import './templates.css';

interface Pending {
  /** null: blank project. */
  id: string | null;
  title: string;
}

function formatMhz(hz: number): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(hz / 1e6)} MHz`;
}

async function apply(id: string | null, title: string): Promise<void> {
  const app = getApp();
  try {
    if (id === null) {
      app.newProject();
      app.setTemplatePickerOpen(false);
      notify('Nouveau projet vide : un PIC16F84A et un main() vide.', 'success');
    } else {
      await app.loadTemplate(id);
      notify(`Modèle ouvert : ${title}`, 'success');
    }
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

const TemplateCard = memo(function TemplateCard({ t, current, onOpen }: { t: TemplateEntry; current: boolean; onOpen(t: TemplateEntry): void }) {
  const preview = useMemo(() => schematicPreviewUrl(t.id, t.schematic), [t.id, t.schematic]);
  return (
    <li>
      <button
        type="button"
        className={`tp-card${current ? ' is-current' : ''}`}
        onClick={() => onOpen(t)}
        aria-label={`Ouvrir le modèle « ${t.title} »${current ? ' (projet actuel)' : ''}`}
        title={t.description}
      >
        <span className="tp-thumb">
          <img src={preview} alt="" loading="lazy" decoding="async" draggable={false} />
        </span>
        <span className="tp-card-body">
          <span className="tp-card-title">{t.title}</span>
          {t.description && <span className="tp-card-desc">{t.description}</span>}
          <span className="tp-card-foot">
            {current && <span className="tp-badge is-current">Ouvert</span>}
            {t.clockHz !== 1_000_000 && <span className="tp-badge">{formatMhz(t.clockHz)}</span>}
            <span className="tp-open">Ouvrir <Icon name="chevronDown" size={12} className="tp-open-chevron" /></span>
          </span>
        </span>
      </button>
    </li>
  );
});

export function TemplatePicker() {
  const templates = appStore.templates;
  const groups = useMemo(() => groupTemplates(templates), [templates]);
  const dirty = useApp((s) => s.dirty);
  const currentId = useApp((s) => s.project.templateId ?? null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);

  const open = (id: string | null, title: string) => {
    if (getApp().dirty) setPending({ id, title });
    else void apply(id, title);
  };

  const saveThenOpen = async () => {
    if (!pending) return;
    setSaving(true);
    await saveProject(false);
    setSaving(false);
    // Saving was cancelled or failed: stay on the question.
    if (getApp().dirty) return;
    const p = pending;
    setPending(null);
    void apply(p.id, p.title);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Escape first closes the question, then (shell) the dialog.
    if (e.key === 'Escape' && pending) {
      e.stopPropagation();
      setPending(null);
    }
  };

  return (
    <div className="tp-picker" onKeyDown={onKeyDown}>
      <header className="tp-head">
        <div className="tp-head-text">
          <h2 className="tp-heading">Modèles de TP</h2>
          <p className="tp-sub">Chaque modèle ouvre le circuit, le code dans le style du cours et son organigramme.</p>
        </div>
        <button type="button" className="icon-button" onClick={() => getApp().setTemplatePickerOpen(false)} aria-label="Fermer" title="Fermer (Échap)">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="tp-body">
        <section className="tp-group" aria-labelledby="tp-g-start">
          <h3 className="tp-group-title" id="tp-g-start">Commencer</h3>
          <ul className="tp-grid">
            <li>
              <button type="button" className="tp-card tp-blank" onClick={() => open(null, 'Projet vide')} aria-label="Créer un projet vide">
                <span className="tp-thumb tp-thumb-blank" aria-hidden="true"><Icon name="plus" size={22} /></span>
                <span className="tp-card-body">
                  <span className="tp-card-title">Projet vide</span>
                  <span className="tp-card-desc">Un PIC16F84A seul : placez vos composants, puis décrivez le programme avec l’assistant.</span>
                </span>
              </button>
            </li>
          </ul>
        </section>
        {groups.map((g) => (
          <section key={g.key} className="tp-group" aria-labelledby={`tp-g-${g.key}`}>
            <h3 className="tp-group-title" id={`tp-g-${g.key}`}>
              {g.title}
              {g.subtitle && <span className="tp-group-sub">{g.subtitle}</span>}
            </h3>
            <ul className="tp-grid">
              {g.items.map((t) => (
                <TemplateCard key={t.id} t={t} current={t.id === currentId} onOpen={(x) => open(x.id, x.title)} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {pending && dirty && (
        <div className="tp-confirm" role="alertdialog" aria-modal="false" aria-labelledby="tp-confirm-text">
          <Icon name="warning" size={16} />
          <p id="tp-confirm-text">
            Le projet actuel a des modifications non enregistrées. Ouvrir « {pending.title} » les remplacera.
          </p>
          <div className="tp-confirm-actions">
            <button type="button" className="tool-button ghost" onClick={() => setPending(null)}>Annuler</button>
            <button type="button" className="tool-button ghost" onClick={() => void saveThenOpen()} disabled={saving}>Enregistrer d’abord</button>
            <button
              type="button"
              className="tool-button primary tp-danger"
              autoFocus
              onClick={() => { const p = pending; setPending(null); void apply(p.id, p.title); }}
            >
              Remplacer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
