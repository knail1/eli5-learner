import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { EditionInfo, UiFeature } from '../../../preload/contract';

/**
 * Edition info, fetched once at startup (11 §11, HOOK-UI-01). In the public build uiFeatures is
 * empty, so every gate renders nothing: gated elements are absent from the DOM, not disabled.
 */

const EditionContext = createContext<EditionInfo | null>(null);

export function EditionProvider(p: { children: ReactNode }) {
  const [info, setInfo] = useState<EditionInfo | null>(null);
  useEffect(() => {
    let live = true;
    void window.eli5.edition.info().then((r) => {
      if (live && r.ok) setInfo(r.value);
    });
    return () => {
      live = false;
    };
  }, []);
  return <EditionContext.Provider value={info}>{p.children}</EditionContext.Provider>;
}

export function useEdition(): EditionInfo | null {
  return useContext(EditionContext);
}

export function FeatureGate(p: { feature: UiFeature; children: ReactNode }) {
  const info = useEdition();
  return info?.uiFeatures.includes(p.feature) ? <>{p.children}</> : null;
}

/** HOOK-UI-02: the overlay may name the edition; the public build says "Public edition". */
export function editionName(info: EditionInfo | null): string {
  if (!info) return '';
  if (info.overlayName) return info.overlayName;
  return info.edition === 'public' ? 'Public edition' : 'Enterprise edition';
}
