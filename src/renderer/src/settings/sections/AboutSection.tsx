import type { HelpTopic } from '../../../../preload/contract';
import { editionName, useEdition } from '../../edition/FeatureGate';
import { SettingsSectionFrame, useAction, type SectionProps } from '../save';

/**
 * Settings > About (11 §7, HOOK-UI-02): name, version, edition, and links to the README and the
 * bundled skills' third-party license notices. Main maps each topic to a fixed link or file.
 */
export function AboutSection(_p: SectionProps) {
  const edition = useEdition();
  const help = useAction();
  const open = (topic: HelpTopic) => void help.run(() => window.eli5.settings.openHelp(topic));
  return (
    <SettingsSectionFrame id="about" title="About">
      <p>ELI5 Learner{edition?.version ? ` ${edition.version}` : ''}</p>
      <p className="muted">{editionName(edition)}</p>
      <div className="row">
        <button type="button" className="link" onClick={() => open('readme')}>
          README
        </button>
        <button type="button" className="link" onClick={() => open('licenses')}>
          Third-party licenses
        </button>
      </div>
      {help.error && <p className="inline-error">{help.error}</p>}
    </SettingsSectionFrame>
  );
}
