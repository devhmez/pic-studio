// « Ce TP »: what the énoncé asks, the parts and why they are wired that way, the pins, how the program works
// step by step (CONFIGURATION → INITIALISATION → boucle) and the classic mistakes.
import { validate, type Program } from '@pic/program-model';
import { asProgram } from '../assistant/model';
import { useMemo } from 'react';
import { appStore, getApp, useApp } from '../state/store';
import { chapterOfTemplate, delaySummary, describeParts, pinTable, programWalkthrough, tpContent, wiringOptions, type WalkItem } from './explain';
import type { LearnContext } from './context';
import { Section, TermChips, Warn } from './ui';

function WalkList({ items }: { items: readonly WalkItem[] }) {
  return (
    <ul className="lp-list">
      {items.map((it, i) => (
        <li key={i}>
          {it.text}
          {it.children && it.children.length > 0 && <WalkList items={it.children} />}
        </li>
      ))}
    </ul>
  );
}

/** The project's program shares less than half of its pin names with the template it was created from. */
function templateDrifted(original: unknown, current: Program | null): boolean {
  const tpl = asProgram(original);
  if (!tpl || !current) return false;
  const names = (p: Program) => new Set([...p.signals.map((s) => s.name.toLowerCase()), ...p.buses.map((b) => b.name.toLowerCase())]);
  const a = names(tpl);
  if (a.size === 0) return false;
  const b = names(current);
  let common = 0;
  for (const n of a) if (b.has(n)) common++;
  return common / a.size < 0.5;
}

export function TpTab({ ctx }: { ctx: LearnContext }) {
  const templateId = useApp((s) => s.project.templateId);
  const projectName = useApp((s) => s.project.name);
  const diagnostics = useApp((s) => s.compile.result?.diagnostics);
  const content = tpContent(templateId);
  const chapter = templateId ? chapterOfTemplate(templateId) : undefined;
  const parts = useMemo(() => describeParts(ctx.topo, ctx.clockHz, wiringOptions(ctx.build?.ast)), [ctx.topo, ctx.clockHz, ctx.build]);
  const pins = useMemo(() => pinTable(ctx.program, ctx.schematic), [ctx.program, ctx.schematic]);
  const walk = useMemo(() => (ctx.program ? programWalkthrough(ctx.program) : null), [ctx.program]);
  const delays = useMemo(() => (ctx.program ? delaySummary({ ...ctx.program, clockHz: ctx.clockHz }) : null), [ctx.program, ctx.clockHz]);
  const issues = useMemo(() => {
    if (!ctx.program) return [];
    try {
      return validate({ ...ctx.program, clockHz: ctx.clockHz }, ctx.schematic).filter((i) => i.severity !== 'info');
    } catch {
      return [];
    }
  }, [ctx.program, ctx.schematic, ctx.clockHz]);
  const warnings = (diagnostics ?? []).filter((d) => d.severity === 'warning');
  const errors = (diagnostics ?? []).filter((d) => d.severity === 'error');
  const template = templateId ? appStore.templates.find((t) => t.id === templateId) : undefined;
  const drifted = useMemo(() => templateDrifted(template?.program ?? null, ctx.program), [template, ctx.program]);

  return (
    <div>
      <div className="lp-card">
        <p className="lp-kicker">{chapter ? `Chapitre ${chapter.number} — ${chapter.title}` : 'Projet'}</p>
        <h3 className="lp-card-title">{content?.title ?? template?.title ?? projectName}</h3>
        {content ? (
          <>
            {drifted && <Warn>Ce projet vient du modèle « {template?.title} », mais son programme ne lui ressemble plus : les consignes ci-dessous sont celles du TP d’origine. Les parties « programme », « composants » et « broches » décrivent bien votre projet.</Warn>}
            <ul className="lp-list">{content.goal.map((g, i) => <li key={i}>{g}</li>)}</ul>
            {content.deliverables && <p className="lp-tip"><strong>À rendre :</strong> {content.deliverables}</p>}
          </>
        ) : (
          <>
            <p className="lp-p lp-muted">
              {ctx.program?.description ?? 'Projet libre : les explications ci-dessous viennent de votre schéma et de votre code.'}
            </p>
            <div className="lp-row">
              <button type="button" className="lp-button" onClick={() => getApp().setTemplatePickerOpen(true)}>Ouvrir un TP du cours</button>
            </div>
          </>
        )}
      </div>

      {content?.tests && (
        <Section title={content.tests.caption} open>
          <div className="lp-table-wrap">
            <table className="lp-table">
              <thead><tr><th>Entrées</th><th>Résultat attendu</th></tr></thead>
              <tbody>{content.tests.rows.map((r, i) => <tr key={i}><td>{r.inputs}</td><td>{r.expected}</td></tr>)}</tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title="Comment marche le programme" open={!!walk}>
        {errors.length > 0 && <Warn>Le code contient {errors.length} erreur{errors.length > 1 ? 's' : ''} : corrigez-les dans le panneau Code pour retrouver l’explication complète.</Warn>}
        {walk ? (
          <>
            {ctx.programOrigin === 'code' && <p className="lp-hint">Lu à partir de votre code C.</p>}
            {walk.map((sec) => (
              <div key={sec.title}>
                <p className="lp-sub">{sec.title}</p>
                <p className="lp-hint">{sec.intro}</p>
                {sec.items.length > 0 && <WalkList items={sec.items} />}
              </div>
            ))}
            {delays && <p className="lp-tip"><strong>Temporisations :</strong> {delays} (1 cycle = 4 périodes d’horloge).</p>}
            <TermChips ids={['organigramme', 'boucle', 'if', 'delay_ms']} label="Voir aussi :" />
          </>
        ) : (
          <p className="lp-p lp-muted">Pas encore de programme lisible : écrivez le code ou décrivez-le avec l’assistant.</p>
        )}
      </Section>

      <Section title="Les composants et leur câblage" count={parts.length}>
        {parts.map((p) => (
          <div key={p.id} className="lp-card">
            <h4 className="lp-card-title">{p.title}{p.pins.length > 0 && <span className="lp-badge">{p.pins.join(', ')}</span>}</h4>
            {p.text.map((t, i) => <p key={i} className="lp-p">{t}</p>)}
            {p.warnings.map((w, i) => <Warn key={i}>{w}</Warn>)}
          </div>
        ))}
        <TermChips ids={['led', 'logicstate', 'pull-up', '7seg-bcd', 'ldr', 'open-drain']} label="Voir aussi :" />
      </Section>

      <Section title="Les broches utilisées" count={pins.length}>
        {pins.length === 0 ? <p className="lp-p lp-muted">Aucune broche du PIC n’est encore utilisée.</p> : (
          <div className="lp-table-wrap">
            <table className="lp-table">
              <thead><tr><th>Broche</th><th>N°</th><th>Sens</th><th>Nom</th><th>Rôle</th></tr></thead>
              <tbody>
                {pins.map((r) => (
                  <tr key={r.pin}>
                    <td className="lp-mono">{r.pin}</td>
                    <td className="lp-mono">{r.number}</td>
                    <td>{r.dir}</td>
                    <td className="lp-mono">{r.name || '—'}</td>
                    <td>{[r.role, r.part].filter(Boolean).join(' — ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="lp-hint">Rappel : TRIS à 1 = entrée, TRIS à 0 = sortie. Les numéros sont ceux du boîtier DIP 18 broches.</p>
      </Section>

      {(content?.mistakes.length || warnings.length || issues.length) ? (
        <Section title="Les erreurs classiques" open={warnings.length + issues.length > 0}>
          {content && <ul className="lp-list">{content.mistakes.map((m, i) => <li key={i}>{m}</li>)}</ul>}
          {(warnings.length > 0 || issues.length > 0) && (
            <>
              <p className="lp-sub">À vérifier dans votre projet</p>
              {warnings.map((d, i) => <Warn key={`d${i}`}>Ligne {d.line} : {d.message}</Warn>)}
              {issues.map((d, i) => <Warn key={`i${i}`}>{d.message}</Warn>)}
            </>
          )}
        </Section>
      ) : null}

      {content?.notes && content.notes.length > 0 && (
        <Section title="Remarques">
          <ul className="lp-list">{content.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}
