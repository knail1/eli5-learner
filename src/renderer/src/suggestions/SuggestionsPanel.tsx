import { useEffect, useRef, useState } from 'react';
import type { MergeSuggestion } from '../../../preload/contract';
import { useAnnounce } from '../a11y/Announcer';

/**
 * Suggestions area at the bottom of the sidebar (11 §5.6). Hidden when there are none. Never
 * steals focus and never opens a modal; only a polite "New suggestion" announcement and the count.
 * 09 §10.4 owns the copy: pending cards show `lastError` beneath; accepting shows "Merging…" with
 * the buttons disabled.
 */

const isOpen = (s: MergeSuggestion) => s.status === 'pending' || s.status === 'accepting';

export function SuggestionsPanel(p: {
  onOpenDoc(slug: string): void;
  /** Slug on screen; when an accept merges it away, the target opens instead (09 §10.6 step 12). */
  currentSlug?: string | null;
}) {
  const announce = useAnnounce();
  const [items, setItems] = useState<MergeSuggestion[]>([]);
  const [merging, setMerging] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const count = useRef<number | null>(null);
  const current = useRef(p.currentSlug);
  current.current = p.currentSlug;

  useEffect(() => {
    const apply = (list: MergeSuggestion[]) => {
      const open = list.filter(isOpen);
      if (count.current !== null && open.length > count.current) announce('New suggestion');
      count.current = open.length;
      setItems(open);
      setMerging(new Set());
      // A fresh list carries lastError; the local IPC error is only a fallback (09 §10.4).
      setErrors({});
    };
    void window.eli5.suggestions.list().then((r) => {
      if (r.ok) apply(r.value);
      else count.current ??= 0; // baseline so the first live suggestion is announced
    });
    return window.eli5.suggestions.onChanged((e) => apply(e.suggestions));
  }, [announce]);

  if (items.length === 0) return null;

  const clearMerging = (id: string) =>
    setMerging((m) => {
      const n = new Set(m);
      n.delete(id);
      return n;
    });

  const accept = async (s: MergeSuggestion) => {
    setMerging((m) => new Set(m).add(s.id));
    setErrors(({ [s.id]: _drop, ...rest }) => rest);
    const r = await window.eli5.suggestions.accept(s.id);
    if (!r.ok) {
      clearMerging(s.id);
      setErrors((e) => ({ ...e, [s.id]: r.error.message }));
      return;
    }
    // The merged-away document was open: show the target (11 §5.6).
    if (current.current === s.source.slug) p.onOpenDoc(r.value.targetSlug);
  };

  const dismiss = async (s: MergeSuggestion) => {
    const r = await window.eli5.suggestions.dismiss(s.id);
    if (r.ok) setItems((list) => list.filter((x) => x.id !== s.id));
    else setErrors((e) => ({ ...e, [s.id]: r.error.message }));
  };

  return (
    <section className="suggestions" aria-labelledby="suggestions-title">
      <h2 id="suggestions-title" className="region-title">
        Suggestions ({items.length})
      </h2>
      <ul>
        {items.map((s) => {
          const busy = merging.has(s.id) || s.status === 'accepting';
          const error = s.lastError ?? errors[s.id];
          return (
            <li key={s.id} className="suggestion-card" aria-busy={busy || undefined}>
              <p>
                This looks related to{' '}
                <TitleLink title={s.target.title} onOpen={() => p.onOpenDoc(s.target.slug)} strong />. Merge it in or
                keep it separate?
              </p>
              <p className="muted suggestion-new">
                New: <TitleLink title={s.source.title} onOpen={() => p.onOpenDoc(s.source.slug)} />
              </p>
              {s.reason && <p className="muted suggestion-reason">{s.reason}</p>}
              <div className="row">
                <button type="button" disabled={busy} onClick={() => void accept(s)}>
                  Merge in
                </button>
                <button type="button" disabled={busy} onClick={() => void dismiss(s)}>
                  Keep separate
                </button>
              </div>
              {busy && <p className="muted">Merging…</p>}
              {!busy && error && <p className="inline-error">{error}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * A document title inside the card's prose. An anchor, not a <button>: a button is an atomic
 * inline-block, so a long title wrapped as its own centered block and pushed the period that
 * follows onto a new line. The anchor flows and wraps like text.
 */
function TitleLink(p: { title: string; onOpen(): void; strong?: boolean }) {
  return (
    <a
      href="#"
      className="title-link"
      title={p.title}
      onClick={(e) => {
        e.preventDefault();
        p.onOpen();
      }}
    >
      {p.strong ? <strong>{p.title}</strong> : p.title}
    </a>
  );
}
