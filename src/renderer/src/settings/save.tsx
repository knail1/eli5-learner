import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DeepPartial, Settings, SettingsSection } from '../../../preload/contract';

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
