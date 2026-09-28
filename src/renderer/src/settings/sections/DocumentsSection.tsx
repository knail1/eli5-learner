import { LockedNote, SaveNote, SettingsSectionFrame, useShownValue, type SectionProps } from '../save';

/** Settings > Documents: the glossary default (11 §7, 12 §3.2 glossary.defaultOn). */
export function DocumentsSection(p: SectionProps) {
  const { state, save } = p.saver;
  const locked = p.isLocked('glossary.defaultOn');
  const [on, setOn] = useShownValue(p.settings.glossary.defaultOn, state['glossary.defaultOn']?.error);
  return (
    <SettingsSectionFrame id="documents" title="Documents">
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={locked}
          onChange={(e) => {
            setOn(e.target.checked);
            save('glossary.defaultOn', { glossary: { defaultOn: e.target.checked } });
          }}
        />
        Explain domain specific terms by default
      </label>
      <LockedNote locked={locked} />
      <SaveNote s={state['glossary.defaultOn']} />
    </SettingsSectionFrame>
  );
}
