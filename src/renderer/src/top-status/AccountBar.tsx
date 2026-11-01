import { useCallback, useEffect, useRef, useState } from 'react';
import { accountActionFor, type AccountAction, type AccountStatus } from '../../../preload/contract';
import { useEdition } from '../edition/FeatureGate';
import { STATUS_POLL_MS } from './CredentialBar';

const ACTION_TEXT: Record<AccountAction, { idle: string; busy: string }> = {
  'sign-in': { idle: 'Sign in', busy: 'Signing in…' },
  install: { idle: 'Install', busy: 'Installing…' },
};

/**
 * Publisher accounts (10 §5.4): one item per available publisher that declares an account. No
 * account-declaring publisher means nothing renders, so the public edition looks as before.
 */
export function AccountBar() {
  const info = useEdition();
  const ids = info?.publishers.filter((p) => p.available && p.account).map((p) => p.id) ?? [];
  if (ids.length === 0) return null;
  return (
    <div className="account-bar" role="group" aria-label="Publishing accounts">
      {ids.map((id) => (
        <AccountItem key={id} targetId={id} />
      ))}
    </div>
  );
}

function AccountItem(p: { targetId: string }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  const refresh = useCallback(() => {
    void window.eli5.publish.accountStatus(p.targetId).then((r) => {
      if (live.current && r.ok) setStatus(r.value);
    });
  }, [p.targetId]);

  useEffect(() => {
    live.current = true;
    refresh();
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    return () => {
      live.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (!status) return null;
  const action = accountActionFor(status.state);
  // `busy` disables the button, so a double-click runs the action once; main also joins duplicates.
  const act = (a: AccountAction): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void window.eli5.publish.accountAction(p.targetId, a).then((r) => {
      if (!live.current) return;
      setBusy(false);
      if (r.ok) setStatus(r.value);
      else setError(r.error.message);
      refresh();
    });
  };
  return (
    <span className={`account-item state-${status.state}`}>
      <span className="status-label">{status.label}</span>
      {action && (
        <button type="button" disabled={busy} onClick={() => act(action)}>
          {busy ? ACTION_TEXT[action].busy : ACTION_TEXT[action].idle}
        </button>
      )}
      {error && (
        <span className="inline-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
