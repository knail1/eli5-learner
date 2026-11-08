import { useState, type DragEvent } from 'react';
import type { Settings, SyncStatus } from '../../../../preload/contract';
import { lastSyncedText, pendingText, seenText, SYNC_PRIVACY, useSyncStatus } from '../../sync/sync-view';
import { LockedNote, SaveNote, SettingsSectionFrame, useAction, useShownValue, type SectionProps } from '../save';

type History = Settings['sync']['history'];

const HISTORY_OPTIONS: { value: History; label: string }[] = [
  { value: 'current', label: 'Current only' },
  { value: 'recent', label: 'Recent (10 newest)' },
  { value: 'all', label: 'All' },
];

const PLATFORM_LABEL: Record<SyncStatus['devices'][number]['platform'], string> = {
  macos: 'Mac',
  android: 'Android',
};

/**
 * Settings > Sync (11 §7 "Sync section", 16 §8). Absent when the sync policy does not allow sync
 * (HOOK-SYNC-01). The Google client JSON is write-only: once saved, only "Client saved in Keychain"
 * shows. Sign-in opens the consent page in the system browser and needs Sync on, so nothing reaches
 * Google while it is off. Every failure renders inline; "Delete cloud copy" confirms inline.
 */
export function SyncSection(p: SectionProps) {
  const { state, save } = p.saver;
  const s = p.settings.sync;
  const view = useSyncStatus();
  const [enabled, setEnabled] = useShownValue(s.enabled, state['sync.enabled']?.error);
  const [inbox, setInbox] = useShownValue(s.inbox.enabled, state['sync.inbox.enabled']?.error);
  const [clientText, setClientText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const client = useAction();
  const account = useAction();
  const now = useAction();
  const primary = useAction();
  const wipe = useAction();

  if (view.unavailable) return null;
  const st = view.status;
  const enabledLocked = p.isLocked('sync.enabled');
  const historyLocked = p.isLocked('sync.history');
  const inboxLocked = p.isLocked('sync.inbox.enabled');
  const configured = st?.configured ?? false;
  const signedIn = st?.signedIn ?? false;
  const active = enabled && st !== null && st.state !== 'off';
  const busy = st?.state === 'syncing';
  const apply = (r: SyncStatus | undefined) => {
    if (r) view.setStatus(r);
  };

  const saveClient = async (json: string) => {
    if (!json.trim()) return;
    const r = await client.run(() => window.eli5.sync.setClient(json));
    if (r) {
      setClientText('');
      apply(r);
    }
  };
  const onDrop = async (e: DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.size > 16 * 1024) return void client.run(async () => tooLarge);
    await saveClient(await file.text());
  };
  const deleteCloudCopy = async () => {
    const done = await wipe.run(async () => {
      const r = await window.eli5.sync.deleteRemote();
      return r.ok ? { ok: true as const, value: true } : r;
    });
    setConfirmDelete(false);
    setDeleted(done === true);
  };
  const phones = (st?.devices ?? []).filter((d) => d.platform === 'android');
  const pending = st ? pendingText(st.pendingUploads) : null;

  return (
    <SettingsSectionFrame id="sync" title="Sync">
      <p className="muted sync-privacy">{SYNC_PRIVACY}</p>
      {view.error && <p className="inline-error">{view.error}</p>}

      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={enabledLocked}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save('sync.enabled', { sync: { enabled: e.target.checked } }, { immediate: true });
          }}
        />
        Sync with my Google Drive
      </label>
      <LockedNote locked={enabledLocked} />
      <SaveNote s={state['sync.enabled']} />

      <div className="field sync-field">
        <span className="field-label">Google client</span>
        {configured ? (
          <div className="field-row">
            <span>Client saved in Keychain</span>
            <button
              type="button"
              disabled={client.busy}
              onClick={() => void client.run(() => window.eli5.sync.clearClient()).then(apply)}
            >
              Remove
            </button>
            {client.error && <span className="inline-error">{client.error}</span>}
          </div>
        ) : (
          <div className="sync-client">
            <textarea
              aria-label="Google client JSON"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder="Paste the Desktop client JSON from Google Cloud, or drop the file here"
              value={clientText}
              onChange={(e) => setClientText(e.target.value)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => void onDrop(e)}
            />
            <div className="field-row">
              <button
                type="button"
                disabled={client.busy || !clientText.trim()}
                onClick={() => void saveClient(clientText)}
              >
                Save client
              </button>
              {client.error && <span className="inline-error">{client.error}</span>}
            </div>
          </div>
        )}
      </div>

      <div className="field sync-field">
        <span className="field-label">Account</span>
        <div className="field-row">
          {signedIn ? (
            <>
              <span data-testid="sync-account">{st?.account ? `Connected as ${st.account}` : 'Connected'}</span>
              <button
                type="button"
                disabled={account.busy}
                onClick={() => void account.run(() => window.eli5.sync.signOut()).then(apply)}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="primary"
                disabled={account.busy || !configured || !active}
                onClick={() => void account.run(() => window.eli5.sync.signIn()).then(apply)}
              >
                {account.busy ? 'Waiting for the browser…' : 'Connect Google Drive'}
              </button>
              {!configured ? (
                <span className="muted">Save your Google client first</span>
              ) : !active ? (
                <span className="muted">Turn on Sync first</span>
              ) : null}
            </>
          )}
          {account.error && <span className="inline-error">{account.error}</span>}
        </div>
      </div>

      <div className="field sync-field">
        <span className="field-label">Versions</span>
        <div className="field-row">
          <select
            aria-label="Versions to sync"
            value={s.history}
            disabled={historyLocked}
            onChange={(e) =>
              save('sync.history', { sync: { history: e.target.value as History } }, { immediate: true })
            }
          >
            {HISTORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <LockedNote locked={historyLocked} />
          <SaveNote s={state['sync.history']} />
        </div>
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={inbox}
          disabled={inboxLocked}
          onChange={(e) => {
            setInbox(e.target.checked);
            save('sync.inbox.enabled', { sync: { inbox: { enabled: e.target.checked } } }, { immediate: true });
          }}
        />
        Accept jobs from phone
      </label>
      <LockedNote locked={inboxLocked} />
      <SaveNote s={state['sync.inbox.enabled']} />
      <p className="muted note">
        {phones.length === 0
          ? 'No phone has synced yet.'
          : `Phones: ${phones.map((d) => `${d.name} (${seenText(d.lastSeen)})`).join(', ')}`}
      </p>

      {st && st.state !== 'off' && (
        <>
          <p className="field-row" role="status" data-testid="sync-status">
            <button
              type="button"
              disabled={now.busy || busy || !signedIn}
              onClick={() => void now.run(() => window.eli5.sync.now())}
            >
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
            <span className="muted">{lastSyncedText(st.lastSyncAt)}</span>
            {pending && <span className="muted">{pending}</span>}
            {now.error && <span className="inline-error">{now.error}</span>}
          </p>
          {st.message && (
            <p className={st.state === 'mirror' ? 'muted note' : 'inline-error'} data-testid="sync-message">
              {st.message}
            </p>
          )}
        </>
      )}

      {st && st.devices.length > 0 && (
        <div className="sync-devices">
          <span className="field-label">Devices</span>
          <ul aria-label="Devices">
            {st.devices.map((d) => (
              <li key={`${d.platform}:${d.name}:${d.role}`}>
                {d.name} · {PLATFORM_LABEL[d.platform]} · {d.role} · {seenText(d.lastSeen)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {st?.state === 'mirror' && (
        <p className="field-row">
          <button
            type="button"
            disabled={primary.busy}
            onClick={() => void primary.run(() => window.eli5.sync.makePrimary()).then(apply)}
          >
            Make this Mac the primary
          </button>
          {primary.error && <span className="inline-error">{primary.error}</span>}
        </p>
      )}

      {signedIn && active && (
        <div className="sync-delete">
          {confirmDelete ? (
            <p className="field-row" role="group" aria-label="Confirm delete cloud copy">
              <span>
                Delete everything ELI5 Learner stored in your Google Drive and turn Sync off? Your Library on this Mac
                stays as it is.
              </span>
              <button type="button" className="danger" disabled={wipe.busy} onClick={() => void deleteCloudCopy()}>
                {wipe.busy ? 'Deleting…' : 'Delete'}
              </button>
              <button type="button" disabled={wipe.busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </p>
          ) : (
            <p className="field-row">
              <button
                type="button"
                disabled={enabledLocked}
                onClick={() => {
                  setDeleted(false);
                  setConfirmDelete(true);
                }}
              >
                Delete cloud copy
              </button>
              {enabledLocked && <span className="muted">Sync is managed by your organization</span>}
            </p>
          )}
          {wipe.error && <span className="inline-error">{wipe.error}</span>}
        </div>
      )}
      {deleted && (
        <p className="muted note" role="status">
          Cloud copy deleted. Sync is off.
        </p>
      )}
    </SettingsSectionFrame>
  );
}

const tooLarge = {
  ok: false as const,
  error: { code: 'E_BAD_REQUEST' as const, message: 'That file is too large to be a Google client' },
};
