import { useEffect, useRef, useState } from 'react';
import type { MergeSuggestion } from '../../../preload/contract';
import { useAnnounce } from '../a11y/Announcer';

/**
 * Suggestions area at the bottom of the sidebar (11 §5.6). Hidden when there are none. Never
 * steals focus; only a polite "New suggestion" announcement and the count. 09 §10.4 owns the copy.
 */

const isOpen = (s: MergeSuggestion) => s.status === 'pending' || s.status === 'accepting';

export function SuggestionsPanel(p: { onOpenDoc(slug: string): void }) {
  const announce = useAnnounce();
  const [items, setItems] = useState<MergeSuggestion[]>([]);
  const [merging, setMerging] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const count = useRef<number | null>(null);

  useEffect(() => {
    const apply = (list: MergeSuggestion[]) => {
      const open = list.filter(isOpen);
      if (count.current !== null && open.length > count.current) announce('New suggestion');
      count.current = open.length;
      setItems(open);
      setMerging(new Set());
    };
    void window.eli5.suggestions.list().then((r) => {
      if (r.ok) apply(r.value);
      else count.current ??= 0; // baseline so the first live suggestion is announced
    });
    return window.eli5.suggestions.onChanged((e) => apply(e.suggestions));
  }, [announce]);

  if (items.length === 0) return null;

  const accept = async (s: MergeSuggestion) => {
    setMerging((m) => new Set(m).add(s.id));
    const r = await window.eli5.suggestions.accept(s.id);
    if (!r.ok) {
      setMerging((m) => {
        const n = new Set(m);
        n.delete(s.id);
        return n;
      });
      setErrors((e) => ({ ...e, [s.id]: r.error.message }));
    }
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
        {items.map((s) => (
          <li key={s.id} className="suggestion-card">
            <p>
              This looks related to{' '}
              <button type="button" className="link" onClick={() => p.onOpenDoc(s.target.slug)}>
                <em>{s.target.title}</em>
              </button>
              . Merge it in or keep it separate?
            </p>
            <p className="muted">
              New:{' '}
              <button type="button" className="link" onClick={() => p.onOpenDoc(s.source.slug)}>
                {s.source.title}
              </button>
            </p>
            {merging.has(s.id) || s.status === 'accepting' ? (
              <p className="muted">Merging…</p>
            ) : (
              <div className="row">
                <button type="button" onClick={() => void accept(s)}>
                  Merge in
                </button>
                <button type="button" onClick={() => void dismiss(s)}>
                  Keep separate
                </button>
              </div>
            )}
            {errors[s.id] && <p className="inline-error">{errors[s.id]}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
