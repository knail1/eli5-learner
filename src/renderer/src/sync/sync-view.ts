import { useEffect, useState } from 'react';
import type { SyncStatus } from '../../../preload/contract';
import { relativeDate } from '../library/order';

/**
 * Personal sync in the renderer (16 §8, 11 §7 "Sync section" and "Sync indicator"): the status
 * subscription shared by Settings > Sync and the sidebar indicator, and the pure text helpers.
 */

/** Settings > Sync privacy line (16 §8), shown at the top of the section at all times. */
export const SYNC_PRIVACY =
  'Turning this on copies your learnings (not your sources or notes) to a hidden folder in your Google Drive. Google can read them.';

export interface SyncView {
  status: SyncStatus | null;
  /** The sync policy does not allow sync (HOOK-SYNC-01): the section and the indicator are absent. */
  unavailable: boolean;
  /** The status could not be read for another reason (one line, never a dialog). */
  error: string | null;
  setStatus(s: SyncStatus): void;
}

/** `eli5:sync:status` once, then every `eli5:sync:changed`. */
export function useSyncStatus(): SyncView {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.eli5.sync.status().then((r) => {
      if (!live) return;
      if (r.ok) setStatus(r.value);
      else if (r.error.code === 'E_NOT_AVAILABLE_IN_EDITION') setUnavailable(true);
      else setError(r.error.message);
    });
    const off = window.eli5.sync.onChanged((s) => {
      setError(null);
      setStatus(s);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return { status, unavailable, error, setStatus };
}

/** The indicator's three states (11 §7), or null when sync is off and the indicator is absent. */
export type IndicatorState = 'synced' | 'syncing' | 'problem';

export function indicatorState(s: SyncStatus | null): IndicatorState | null {
  if (!s || s.state === 'off') return null;
  if (s.state === 'syncing') return 'syncing';
  if (s.state === 'idle' || s.state === 'mirror') return 'synced';
  return 'problem';
}

/** Accessible name and tooltip of the indicator. */
export function indicatorLabel(s: SyncStatus): string {
  switch (s.state) {
    case 'syncing':
      return 'Sync: syncing';
    case 'idle':
      return s.pendingUploads > 0 ? 'Sync: changes waiting' : 'Sync: up to date';
    case 'mirror':
      return `Sync: ${s.message ?? 'another Mac is the primary'}`;
    case 'not-configured':
      return 'Sync: add your Google client in Settings';
    case 'signed-out':
      return 'Sync: not connected to Google Drive';
    case 'paused-read-only':
      return 'Sync: paused while the Library is read-only';
    default:
      return `Sync: ${s.message ?? 'offline or failed'}`;
  }
}

/** "Last synced 5m ago", "Last synced just now", "Not synced yet". */
export function lastSyncedText(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return 'Not synced yet';
  const r = relativeDate(iso, now);
  if (!r) return 'Not synced yet';
  if (r === 'now') return 'Last synced just now';
  return /^\d+[mhdw]$/.test(r) ? `Last synced ${r} ago` : `Last synced ${r}`;
}

/** "Seen 5m ago" for a device row. */
export function seenText(iso: string, now: number = Date.now()): string {
  const r = relativeDate(iso, now);
  if (!r) return '';
  if (r === 'now') return 'seen just now';
  return /^\d+[mhdw]$/.test(r) ? `seen ${r} ago` : `seen ${r}`;
}

export function pendingText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 document waiting to upload' : `${n} documents waiting to upload`;
}
