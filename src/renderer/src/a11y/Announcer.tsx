import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Live region announcer (11 §12): polite for started, done and new suggestion; assertive only
 * for failed jobs. Intermediate stages are never announced.
 */

const ZWSP = String.fromCharCode(0x200b);

type Announce = (text: string, urgency?: 'polite' | 'assertive') => void;

const AnnouncerContext = createContext<Announce>(() => {});

export function AnnouncerProvider(p: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const seq = useRef(0);
  const announce = useCallback<Announce>((text, urgency = 'polite') => {
    // A trailing zero-width variation makes a repeated message re-announce.
    seq.current += 1;
    const t = seq.current % 2 ? text : `${text}${ZWSP}`;
    if (urgency === 'assertive') setAssertive(t);
    else setPolite(t);
  }, []);
  const value = useMemo(() => announce, [announce]);
  return (
    <AnnouncerContext.Provider value={value}>
      {p.children}
      <div className="visually-hidden" aria-live="polite" role="status" data-testid="announcer-polite">
        {polite}
      </div>
      <div className="visually-hidden" aria-live="assertive" role="alert" data-testid="announcer-assertive">
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnouncerContext);
}
