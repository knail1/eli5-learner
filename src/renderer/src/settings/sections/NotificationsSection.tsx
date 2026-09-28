import { SaveNote, SettingsSectionFrame, type SectionProps } from '../save';

/**
 * Settings > Notifications (11 §7 "Notifications section", §14). Skeleton: the switch only; the
 * notifications slice adds the click-action radios, preferred link, test button and permission line.
 */
export function NotificationsSection(p: SectionProps) {
  const { state, save } = p.saver;
  return (
    <SettingsSectionFrame id="notifications" title="Notifications">
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          checked={p.settings.notifications.enabled}
          onChange={(e) => save('notifications.enabled', { notifications: { enabled: e.target.checked } })}
        />
        Notify me when a document is ready
      </label>
      <SaveNote s={state['notifications.enabled']} />
    </SettingsSectionFrame>
  );
}
