import { useEffect, useRef } from 'react';
import type { Settings, SettingsSection } from '../../../preload/contract';
import { useSettingSaver } from './save';
import { AboutSection } from './sections/AboutSection';
import { AiSection } from './sections/AiSection';
import { DocumentsSection } from './sections/DocumentsSection';
import { EnterpriseSection } from './sections/EnterpriseSection';
import { LibrarySection } from './sections/LibrarySection';
import { NotificationsSection } from './sections/NotificationsSection';
import { PublishingSection } from './sections/PublishingSection';

export { SignInIndicator } from './sections/EnterpriseSection';

/**
 * In-window settings route (11 §7). Composes one component per section (settings/sections/) in
 * the 11 §7 order; `section` scrolls to and focuses that section's heading.
 */
export function SettingsScreen(p: { settings: Settings | null; section?: SettingsSection; onKeyChanged(): void }) {
  const saver = useSettingSaver();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = p.section ? root.current?.querySelector<HTMLElement>(`#settings-${p.section}`) : root.current;
    target?.scrollIntoView?.({ block: 'start' });
    target?.querySelector<HTMLElement>('h2')?.focus();
  }, [p.section]);

  if (!p.settings) return <p className="muted settings">Loading settings…</p>;
  const props = { settings: p.settings, saver };

  return (
    <div className="settings" ref={root}>
      <h1>Settings</h1>
      <AiSection {...props} onKeyChanged={p.onKeyChanged} />
      <DocumentsSection {...props} />
      <LibrarySection {...props} />
      <PublishingSection {...props} />
      <NotificationsSection {...props} />
      <AboutSection {...props} />
      <EnterpriseSection {...props} />
    </div>
  );
}
