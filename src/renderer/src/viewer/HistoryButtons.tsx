import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocHistoryState, IpcResult } from '../../../preload/contract';
import { isTextEntry, matchHistoryKey } from '../a11y/shortcuts';

/**
 * Undo / Redo for the open document (11 §5.3, 09 §4.1): main keeps exactly one prior version, so
 * one of the two is available at a time. State comes from `eli5:doc:history` and follows
 * `eli5:doc:history-changed`. Cmd+Z / Shift+Cmd+Z act here only when focus is not in a text field;
 * text fields keep the Edit menu's own undo (11 §9).
 */

const NONE: DocHistoryState = { canUndo: false, canRedo: false };
const BUSY_TIP = 'Wait for the section update to finish';

/** A curved arrow (↶); Redo mirrors it. Drawn with currentColor to match the button text. */
function ArrowIcon(p: { mirrored?: boolean }) {
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
      style={p.mirrored ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M5.5 3.5 2.5 6.5l3 3" />
      <path d="M2.5 6.5h7a4 4 0 0 1 0 8H7" />
    </svg>
  );
}

export function tooltip(dir: 'undo' | 'redo', s: DocHistoryState): string {
  if (s.busy) return BUSY_TIP;
  if (dir === 'undo') return s.canUndo ? `Undo: ${s.undoLabel ?? 'last change'} (⌘Z)` : 'Nothing to undo';
  return s.canRedo ? `Redo: ${s.redoLabel ?? 'last change'} (⇧⌘Z)` : 'Nothing to redo';
}

export function HistoryButtons(p: { slug: string }) {
  const [state, setState] = useState<DocHistoryState>(NONE);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugRef = useRef(p.slug);
  slugRef.current = p.slug;

  useEffect(() => {
    let live = true;
    setState(NONE);
    setError(null);
    void window.eli5.doc.history(p.slug).then((r) => {
      if (live && r.ok) setState(r.value);
    });
    const off = window.eli5.doc.onHistoryChanged((e) => {
      if (e.slug === slugRef.current) setState(e.state);
    });
    return () => {
      live = false;
      off();
    };
  }, [p.slug]);

  const canUndo = state.canUndo && !state.busy && !pending;
  const canRedo = state.canRedo && !state.busy && !pending;

  const run = useCallback(async (dir: 'undo' | 'redo') => {
    const slug = slugRef.current;
    setPending(true);
    let r: IpcResult<DocHistoryState>;
    try {
      r = await (dir === 'undo' ? window.eli5.doc.undo(slug) : window.eli5.doc.redo(slug));
    } finally {
      setPending(false);
    }
    if (slugRef.current !== slug) return;
    if (r.ok) {
      setState(r.value);
      setError(null);
    } else {
      setError(r.error.message);
    }
  }, []);

  const enabled = useRef({ undo: canUndo, redo: canRedo });
  enabled.current = { undo: canUndo, redo: canRedo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const dir = matchHistoryKey(e);
      if (!dir || isTextEntry(e.target instanceof Element ? e.target : document.activeElement)) return;
      e.preventDefault();
      if (enabled.current[dir]) void run(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label="Undo"
        title={tooltip('undo', state)}
        disabled={!canUndo}
        onClick={() => void run('undo')}
      >
        <ArrowIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Redo"
        title={tooltip('redo', state)}
        disabled={!canRedo}
        onClick={() => void run('redo')}
      >
        <ArrowIcon mirrored />
      </button>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
