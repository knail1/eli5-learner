import { useState } from 'react';
import type { EditionInfo, Settings, TestNotificationResult } from '../../../../preload/contract';
import { useEdition } from '../../edition/FeatureGate';
import { SaveNote, SettingsSectionFrame, useShownValue, type SectionProps } from '../save';

type ClickAction = Settings['notifications']['clickAction'];
type PreferredLink = Settings['notifications']['preferredLink'];

const LINK_OPTIONS: { value: PreferredLink; label: string }[] = [
  { value: 'most-recent', label: 'Most recent' },
  { value: 'drive', label: 'Cloud drive' },
  { value: 'site', label: 'GitHub Pages' },
];

const UNSUPPORTED = "Notifications aren't supported on this system";

/** 11 §7: any publisher other than `local` reporting available (stubs report false). */
function hasRemotePublisher(info: EditionInfo | null): boolean {
  return !!info?.publishers.some((p) => p.id !== 'local' && p.available);
}

function testMessage(r: TestNotificationResult): string {
  if (r.shown) return 'Sent. If nothing appeared, check macOS notification settings.';
  return r.reason === 'unsupported' ? UNSUPPORTED : 'Notifications are turned off';
}

/**
 * Settings > Notifications (11 §7 "Notifications section", §14). The renderer learns that
 * notifications are unsupported only from a test result (§14.6), which disables the controls.
 */
export function NotificationsSection(p: SectionProps) {
  const { state, save } = p.saver;
  const n = p.settings.notifications;
  const remote = hasRemotePublisher(useEdition());
  const [test, setTest] = useState<{ text: string; error: boolean } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [enabled, setEnabled] = useShownValue(n.enabled, state['notifications.enabled']?.error);

  const sendTest = async () => {
    const r = await window.eli5.app.testNotification();
    if (!r.ok) return setTest({ text: r.error.message, error: true });
    if (r.value.reason === 'unsupported') setUnsupported(true);
    setTest({ text: testMessage(r.value), error: false });
  };
  const setAction = (clickAction: ClickAction) => save('notifications.clickAction', { notifications: { clickAction } });

  return (
    <SettingsSectionFrame id="notifications" title="Notifications">
      {unsupported && <p className="muted">{UNSUPPORTED}</p>}
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={unsupported}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save('notifications.enabled', { notifications: { enabled: e.target.checked } });
          }}
        />
        Notify me when a document is ready
      </label>
      <SaveNote s={state['notifications.enabled']} />

      <div role="radiogroup" aria-label="When I click a notification">
        <span className="field-label">When I click a notification</span>
        <label>
          <input
            type="radio"
            name="notifications-click"
            checked={n.clickAction === 'app'}
            disabled={unsupported}
            onChange={() => setAction('app')}
          />
          Open it in ELI5 Learner
        </label>
        <label>
          <input
            type="radio"
            name="notifications-click"
            checked={n.clickAction === 'published-link'}
            disabled={unsupported || !remote}
            aria-describedby={remote ? undefined : 'notifications-link-help'}
            onChange={() => setAction('published-link')}
          />
          Open its published link in my browser
        </label>
        <select
          aria-label="Which published link"
          value={n.preferredLink}
          disabled={unsupported || !remote || n.clickAction !== 'published-link'}
          onChange={(e) =>
            save('notifications.preferredLink', {
              notifications: { preferredLink: e.target.value as PreferredLink },
            })
          }
        >
          {LINK_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {!remote && (
          <p className="muted" id="notifications-link-help">
            Available when documents can be published to a cloud drive or GitHub Pages
          </p>
        )}
      </div>
      <SaveNote s={state['notifications.clickAction']} />
      <SaveNote s={state['notifications.preferredLink']} />

      <p>
        <button type="button" onClick={() => void sendTest()}>
          Send test notification
        </button>{' '}
        {test && (
          <span className={test.error ? 'inline-error' : 'muted'} role="status">
            {test.text}
          </span>
        )}
      </p>
      <p className="muted">
        macOS asks for permission the first time ELI5 Learner shows a notification. If you don&apos;t see them, allow
        them in System Settings &gt; Notifications &gt; ELI5 Learner &gt; Allow notifications.
      </p>
      <button type="button" onClick={() => void window.eli5.app.openNotificationSettings()}>
        Open macOS notification settings
      </button>
    </SettingsSectionFrame>
  );
}
