import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DeepPartial, IpcResult, Settings, SettingsDescription, SettingsSection } from '../../../preload/contract';

/**
 * Shared settings plumbing (11 §7): non-secret settings save on change, debounced 300 ms, with a
 * quiet "Saved" or an inline error. Every section component receives a SectionProps.
 */

const SAVE_DEBOUNCE_MS = 300;

export type SaveState = Record<string, { saved: boolean; error?: string }>;

export interface SettingSaver {
  state: SaveState;
  /** Debounced `eli5:settings:set` of `patch`; `key` is the dotted path the note belongs to. */
  save(key: string, patch: DeepPartial<Settings>): void;
}

export interface SectionProps {
  settings: Settings;
  saver: SettingSaver;
  /** True when an overlay manages the key (HOOK-CFG-01): its control is read-only. */
  isLocked(path: string): boolean;
}

/** 12 §13 E_SETTINGS_LOCKED text, shown next to a managed control. */
export const LOCKED_TEXT = 'This setting is managed by your organization';

export function LockedNote(p: { locked: boolean }) {
  return p.locked ? <span className="muted locked-note">{LOCKED_TEXT}</span> : null;
}

/** `eli5:settings:describe`, fetched once per mount; null until it answers or when it fails. */
export function useSettingsDescription(): SettingsDescription | null {
  const [desc, setDesc] = useState<SettingsDescription | null>(null);
  useEffect(() => {
    let live = true;
    void window.eli5.settings.describe().then((r) => {
      if (live && r.ok) setDesc(r.value);
    });
    return () => {
      live = false;
    };
  }, []);
  return desc;
}

/** A key is locked when it, or a namespace above it, is managed. */
export function lockedPredicate(desc: SettingsDescription | null): (path: string) => boolean {
  const locked = (desc?.keys ?? []).filter((k) => k.locked).map((k) => k.path);
  return (path) => locked.some((l) => path === l || path.startsWith(`${l}.`));
}

/** 12 §4.2: load issues as one non-modal line, never a dialog. */
export function loadIssuesText(issues: SettingsDescription['loadIssues']): string | null {
  if (issues.length === 0) return null;
  if (issues.some((i) => i.reason === 'corrupt-file'))
    return "The settings file couldn't be read, so defaults are in use";
  return issues.length === 1
    ? '1 setting was reset to its default'
    : `${issues.length} settings were reset to defaults`;
}

/**
 * A one-shot, user-initiated IPC action (reveal, choose folder, help link): busy while pending,
 * `error` holds the returned message for inline display (11 §13, never a modal).
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(call: () => Promise<IpcResult<T>>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    const r = await call();
    if (!live.current) return undefined;
    setBusy(false);
    if (r.ok) return r.value;
    setError(r.error.message);
    return undefined;
  }, []);
  return { busy, error, run };
}

export function useSettingSaver(): SettingSaver {
  const [state, setState] = useState<SaveState>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);
  const save = useCallback((key: string, patch: DeepPartial<Settings>) => {
    clearTimeout(timers.current.get(key));
    setState((s) => ({ ...s, [key]: { saved: false } }));
    timers.current.set(
      key,
      setTimeout(() => {
        void window.eli5.settings.set(patch).then((r) => {
          setState((s) => ({ ...s, [key]: r.ok ? { saved: true } : { saved: false, error: r.error.message } }));
        });
      }, SAVE_DEBOUNCE_MS),
    );
  }, []);
  return { state, save };
}

/**
 * The value a control shows: the user's choice at once on change (saves are debounced), then each
 * new settings snapshot, or the stored value again when that save failed (11 §7).
 */
export function useShownValue<T>(value: T, error: string | undefined): [T, (v: T) => void] {
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value, error]);
  return [shown, setShown];
}

export function SaveNote(p: { s: { saved: boolean; error?: string } | undefined }) {
  if (p.s?.error) return <span className="inline-error">{p.s.error}</span>;
  return p.s?.saved ? <span className="saved">Saved</span> : null;
}

/** `<section id="settings-<id>">` with a focusable h2, the target of UiRoute.section (11 §6). */
export function SettingsSectionFrame(p: { id: SettingsSection; title: string; children?: ReactNode }) {
  return (
    <section id={`settings-${p.id}`} aria-labelledby={`h-${p.id}`}>
      <h2 id={`h-${p.id}`} tabIndex={-1}>
        {p.title}
      </h2>
      {p.children}
    </section>
  );
}
