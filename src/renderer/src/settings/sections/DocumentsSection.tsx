import { SaveNote, SettingsSectionFrame, type SectionProps } from '../save';

/** Settings > Documents: the glossary default (11 §7, 12 §3.2 glossary.defaultOn). */
export function DocumentsSection(p: SectionProps) {
  const { state, save } = p.saver;
  return (
    <SettingsSectionFrame id="documents" title="Documents">
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={p.settings.glossary.defaultOn}
          onChange={(e) => save('glossary.defaultOn', { glossary: { defaultOn: e.target.checked } })}
        />
        Explain domain specific terms by default
      </label>
      <SaveNote s={state['glossary.defaultOn']} />
    </SettingsSectionFrame>
  );
}
