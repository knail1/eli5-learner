import { editionName, useEdition } from '../../edition/FeatureGate';
import { SettingsSectionFrame, type SectionProps } from '../save';

/** Settings > About: name, version, edition (11 §7, HOOK-UI-02). */
export function AboutSection(_p: SectionProps) {
  const edition = useEdition();
  return (
    <SettingsSectionFrame id="about" title="About">
      <p>ELI5 Learner{edition?.version ? ` ${edition.version}` : ''}</p>
      <p className="muted">{editionName(edition)}</p>
    </SettingsSectionFrame>
  );
}
