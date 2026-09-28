import { SaveNote, SettingsSectionFrame, type SectionProps } from '../save';

/** Settings > Publishing: export folder and reveal-after switch (11 §7, 10 §10). */
export function PublishingSection(p: SectionProps) {
  const { state, save } = p.saver;
  const s = p.settings;
  return (
    <SettingsSectionFrame id="publishing" title="Publishing">
      <p>
        <span className="field-label">Export folder</span> <code className="path">{s.publish.local.dir}</code>
      </p>
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={s.publish.local.revealAfter}
          onChange={(e) => save('publish.local.revealAfter', { publish: { local: { revealAfter: e.target.checked } } })}
        />
        Reveal in Finder after export
      </label>
      <SaveNote s={state['publish.local.revealAfter']} />
    </SettingsSectionFrame>
  );
}
