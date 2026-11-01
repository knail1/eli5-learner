import { useCallback, useEffect, useRef, useState } from 'react';
import type { CredentialStatus, IpcResult } from '../../../preload/contract';

/** Re-read interval for status bars in the top-status holder (02 §14, 10 §5.4). */
export const STATUS_POLL_MS = 60_000;

const STATE_WORDS: Record<CredentialStatus['state'], string> = {
  ok: 'Signed in',
  expiring: 'Expiring soon',
  expired: 'Expired',
  unknown: 'Unknown',
};

type Busy = 'reload' | 'sign-in';

/**
 * Credential state of the active AI provider (02 §14). Renders nothing until a status arrives and
 * nothing at all for providers without the seam. A failed poll keeps the last status shown.
 */
export function CredentialBar() {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<Busy>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  const accept = useCallback((r: IpcResult<CredentialStatus | null>): void => {
    if (!live.current || !r.ok) return;
    setStatus(r.value);
    if (r.value && r.value.state !== 'expired') setError(null);
  }, []);

  const refresh = useCallback(() => void window.eli5.llm.credentialStatus().then(accept), [accept]);

  useEffect(() => {
    live.current = true;
    refresh();
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    // A provider switch changes which provider answers.
    const unsub = window.eli5.settings.onChanged((e) => {
      if (e.changed.some((k) => k.startsWith('llm'))) refresh();
    });
    return () => {
      live.current = false;
      window.clearInterval(timer);
      unsub();
    };
  }, [refresh]);

  // Each button disables only itself, so Reload can pick up an external re-login while a
  // browser sign-in is still pending.
  const run = (kind: Busy, call: () => Promise<IpcResult<CredentialStatus | null>>): void => {
    if (busy.has(kind)) return;
    setBusy((b) => new Set(b).add(kind));
    void call().then((r) => {
      if (!live.current) return;
      setBusy((b) => {
        const next = new Set(b);
        next.delete(kind);
        return next;
      });
      if (r.ok) accept(r);
      else setError(r.error.message);
    });
  };

  if (!status) return null;
  const text = status.label?.trim() || STATE_WORDS[status.state];
  return (
    <div className={`credential-bar state-${status.state}`} role="group" aria-label="AI service credentials">
      <span className="status-label" title={status.expiresAt}>
        {text}
      </span>
      <button
        type="button"
        disabled={busy.has('reload')}
        onClick={() => run('reload', window.eli5.llm.reloadCredentials)}
      >
        Reload
      </button>
      <button type="button" disabled={busy.has('sign-in')} onClick={() => run('sign-in', window.eli5.llm.signIn)}>
        {busy.has('sign-in') ? 'Signing in…' : 'Sign in'}
      </button>
      {error && (
        <span className="inline-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
