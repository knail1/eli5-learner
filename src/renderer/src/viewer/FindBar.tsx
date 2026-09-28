import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

/**
 * Find in document (11 §5.3 find bar). It sits above the viewer slot and takes layout space: the
 * viewer is a native view over the renderer, so an overlay would be hidden under it. The search
 * runs in the viewer (`eli5:viewer:find`); results come back as `eli5:viewer:find-result`.
 *
 * Search as you type (150 ms debounce), case-insensitive. Enter / Shift+Enter (and Cmd+G /
 * Shift+Cmd+G through the handle) move to the next / previous match; Escape or Done closes the bar.
 * Unmounting ends the search and clears the highlight.
 */

export interface FindBarHandle {
  /** Focuses the field and selects its text (Cmd+F while the bar is open). */
  focus(): void;
  next(): void;
  previous(): void;
}

const DEBOUNCE_MS = 150;
/** Matches main's cap (`eli5:viewer:find`); longer text is not typed in. */
const MAX_CHARS = 200;

function Chevron(p: { up?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={p.up ? 'M3.5 10 8 5.5l4.5 4.5' : 'M3.5 6 8 10.5 12.5 6'} />
    </svg>
  );
}

export function countLabel(c: { active: number; matches: number } | null): string {
  if (!c) return '';
  return c.matches === 0 ? 'No matches' : `${String(Math.max(1, c.active))} of ${String(c.matches)}`;
}

export function FindBar(p: {
  initialQuery: string;
  onQueryChange(q: string): void;
  onClose(): void;
  handle?: Ref<FindBarHandle>;
}) {
  const [text, setText] = useState(p.initialQuery);
  const [count, setCount] = useState<{ active: number; matches: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  /** Text of the running search; null when none (empty field, or the viewer reloaded). */
  const session = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const search = (t: string): void => {
    clearTimeout(timer.current);
    setCount(null);
    if (!t) {
      session.current = null;
      void window.eli5.viewer.stopFind();
      return;
    }
    session.current = t;
    void window.eli5.viewer.find(t, { forward: true });
  };

  const step = (forward: boolean): void => {
    const t = textRef.current;
    if (!t) return;
    if (session.current !== t) {
      search(t);
      return;
    }
    void window.eli5.viewer.find(t, { forward, again: true });
  };

  const focus = (): void => {
    input.current?.focus();
    input.current?.select();
  };

  useImperativeHandle(p.handle, () => ({ focus, next: () => step(true), previous: () => step(false) }));

  useEffect(() => {
    focus();
    if (textRef.current) search(textRef.current);
    const off = window.eli5.viewer.onFindResult((e) => {
      if (e.kind === 'result') {
        if (session.current === null) return;
        setCount((c) => ({
          // Interim updates can report ordinal 0 before the active match is known.
          active: e.activeMatchOrdinal || (c?.active ?? 0),
          matches: e.matches,
        }));
        return;
      }
      if (e.reason === 'tab' && session.current !== null) {
        search(session.current);
      } else {
        // Reload: the page was replaced (a section update, undo or merge); the next Enter starts over.
        session.current = null;
        setCount(null);
      }
    });
    return () => {
      off();
      clearTimeout(timer.current);
      void window.eli5.viewer.stopFind();
    };
    // Mount-only: the handlers read refs.
  }, []);

  const onChange = (v: string): void => {
    setText(v);
    p.onQueryChange(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(v), DEBOUNCE_MS);
  };

  return (
    <div
      className="find-bar"
      role="search"
      aria-label="Find in document"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        p.onClose();
      }}
    >
      <input
        ref={input}
        type="text"
        className="find-field"
        aria-label="Find in document"
        placeholder="Find in document"
        spellCheck={false}
        autoComplete="off"
        maxLength={MAX_CHARS}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          step(!e.shiftKey);
        }}
      />
      <span className="find-count muted" role="status" aria-live="polite">
        {countLabel(count)}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Previous match"
        title="Previous match (⇧⌘G)"
        onClick={() => step(false)}
      >
        <Chevron up />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Next match"
        title="Next match (⌘G)"
        onClick={() => step(true)}
      >
        <Chevron />
      </button>
      <button type="button" onClick={p.onClose}>
        Done
      </button>
    </div>
  );
}
