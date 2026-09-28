import { LockedNote, SaveNote, SettingsSectionFrame, useShownValue, type SectionProps } from '../save';

/**
 * Settings > Documents (11 §7): the glossary default (12 §3.2 glossary.defaultOn) and stock photos
 * (images.stockPhotos, 07 §7.4). Either may be locked by an organization (HOOK-CFG-01).
 */
export function DocumentsSection(p: SectionProps) {
  const { state, save } = p.saver;
  const glossaryLocked = p.isLocked('glossary.defaultOn');
  const photosLocked = p.isLocked('images.stockPhotos');
  const [on, setOn] = useShownValue(p.settings.glossary.defaultOn, state['glossary.defaultOn']?.error);
  const [photos, setPhotos] = useShownValue(p.settings.images.stockPhotos, state['images.stockPhotos']?.error);
  return (
    <SettingsSectionFrame id="documents" title="Documents">
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={glossaryLocked}
          onChange={(e) => {
            setOn(e.target.checked);
            save('glossary.defaultOn', { glossary: { defaultOn: e.target.checked } });
          }}
        />
        Explain domain specific terms by default
      </label>
      <LockedNote locked={glossaryLocked} />
      <SaveNote s={state['glossary.defaultOn']} />
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={photos}
          disabled={photosLocked}
          aria-describedby="stock-photos-hint"
          onChange={(e) => {
            setPhotos(e.target.checked);
            save('images.stockPhotos', { images: { stockPhotos: e.target.checked } });
          }}
        />
        Use stock photos for real-world scenes
      </label>
      <p className="muted" id="stock-photos-hint">
        Open-licensed photos from public libraries, credited in each document. Only a few generic search words leave
        your Mac, never your sources. When off, documents use diagrams only.
      </p>
      <LockedNote locked={photosLocked} />
      <SaveNote s={state['images.stockPhotos']} />
    </SettingsSectionFrame>
  );
}
