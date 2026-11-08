import { indicatorLabel, indicatorState, useSyncStatus, type IndicatorState } from './sync-view';

/** A small cloud with a mark per state: a check (synced), two arrows (syncing), a slash (problem). */
function CloudIcon(p: { state: IndicatorState }) {
  return (
    <svg viewBox="0 0 20 16" width="18" height="14" aria-hidden="true" focusable="false">
      <path
        d="M5.5 14h9.25a3.75 3.75 0 0 0 .4-7.48A5.25 5.25 0 0 0 5.1 5.6 4.25 4.25 0 0 0 5.5 14Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {p.state === 'synced' && (
        <path d="m7.2 9.6 2 2 3.8-3.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
      {p.state === 'syncing' && (
        <path
          d="M7.4 9.2a2.6 2.6 0 0 1 4.6-1.2m.6 2.6a2.6 2.6 0 0 1-4.6 1.2m3.7-4.6.3 1.4-1.4.2m-3 3.4-.3-1.4 1.4-.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      )}
      {p.state === 'problem' && (
        <path d="M3 2 17 15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

/**
 * Sidebar footer sync indicator (11 §7, 16 §8): absent while sync is off or not allowed; otherwise
 * synced, syncing, or offline/error. It opens Settings > Sync.
 */
export function SyncIndicator(p: { onOpen(): void }) {
  const { status } = useSyncStatus();
  const state = indicatorState(status);
  if (!status || !state) return null;
  const label = indicatorLabel(status);
  return (
    <button
      type="button"
      className={`sync-indicator sync-${state}`}
      aria-label={label}
      title={label}
      data-state={state}
      onClick={p.onOpen}
    >
      <CloudIcon state={state} />
    </button>
  );
}
