import { useEffect, useState } from 'react';
import type { AuthStatus } from '../../../../preload/contract';
import { FeatureGate } from '../../edition/FeatureGate';
import { SettingsSectionFrame, type SectionProps } from '../save';

/** Settings > Enterprise: mounted only when HOOK-UI-01 enables auth.signIn (11 §11). */
export function EnterpriseSection(_p: SectionProps) {
  return (
    <FeatureGate feature="auth.signIn">
      <SettingsSectionFrame id="enterprise" title="Enterprise">
        <SignInIndicator />
      </SettingsSectionFrame>
    </FeatureGate>
  );
}

/** Generic sign-in indicator, mounted only when HOOK-UI-01 enables auth.signIn. */
export function SignInIndicator() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  useEffect(() => {
    void window.eli5.auth.status().then((r) => r.ok && setStatus(r.value));
    return window.eli5.auth.onChanged(setStatus);
  }, []);
  const label =
    status?.state === 'signed-in' ? 'Signed in' : status?.state === 'expired' ? 'Session expired · Sign in' : 'Sign in';
  const signedIn = status?.state === 'signed-in';
  return (
    <button
      type="button"
      className="sign-in"
      disabled={signedIn}
      onClick={() => void window.eli5.auth.signIn().then((r) => r.ok && setStatus(r.value))}
    >
      {label}
    </button>
  );
}
