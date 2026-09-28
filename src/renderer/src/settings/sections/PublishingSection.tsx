import { useEffect, useState } from 'react';
import { LockedNote, SaveNote, SettingsSectionFrame, useAction, useShownValue, type SectionProps } from '../save';

/**
 * Settings > Publishing (11 §7, 10 §5.1): the export folder (read-only path + Choose…, the app's
 * only native panel; main validates and saves), the reveal-after switch, and the Pages help link
 * (10 §8). Remote publishing settings are dormant and have no controls here (HOOK-UI-01).
 */
export function PublishingSection(p: SectionProps) {
  const { state, save } = p.saver;
  const s = p.settings;
  const dirLocked = p.isLocked('publish.local.dir');
  const revealLocked = p.isLocked('publish.local.revealAfter');
  const [reveal, setReveal] = useShownValue(s.publish.local.revealAfter, state['publish.local.revealAfter']?.error);
  const choose = useAction();
  const help = useAction();
  // The chosen path shows at once; the next settings snapshot then takes over.
  const [dir, setDir] = useState(s.publish.local.dir);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDir(s.publish.local.dir), [s.publish.local.dir]);

  const chooseFolder = async () => {
    setSaved(false);
    const r = await choose.run(() => window.eli5.settings.chooseFolder('publish.local.dir'));
    if (r && 'path' in r) {
      setDir(r.path);
      setSaved(true);
    }
  };

  return (
    <SettingsSectionFrame id="publishing" title="Publishing">
      <div className="row">
        <span className="field-label">Export folder</span> <code className="path">{dir}</code>
        <button type="button" disabled={dirLocked || choose.busy} onClick={() => void chooseFolder()}>
          Choose…
        </button>
        <LockedNote locked={dirLocked} />
        <SaveNote s={choose.error ? { saved: false, error: choose.error } : { saved }} />
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={reveal}
          disabled={revealLocked}
          onChange={(e) => {
            setReveal(e.target.checked);
            save('publish.local.revealAfter', { publish: { local: { revealAfter: e.target.checked } } });
          }}
        />
        Reveal in Finder after export
      </label>
      <LockedNote locked={revealLocked} />
      <SaveNote s={state['publish.local.revealAfter']} />
      <p>
        <button
          type="button"
          className="link"
          onClick={() => void help.run(() => window.eli5.settings.openHelp('publish-pages'))}
        >
          How to set up a Pages repository
        </button>{' '}
        {help.error && <span className="inline-error">{help.error}</span>}
      </p>
    </SettingsSectionFrame>
  );
}
