import type { TestNotificationResult } from '../../preload/contract';
import type { NotificationControls } from './app';
import type { SectionActions } from './doc';
import { fail } from './handle';
import type { PublishService } from './publish';
import type { FolderChooser } from './settings';
import type { MergeSuggestions } from './suggestions';

/**
 * M3 service slots (dependency injection points). Each feature slice implements one interface;
 * bootstrap (src/main/index.ts) plugs the factories in. A missing slot answers every invoke with
 * E_INTERNAL "Not implemented yet" and never emits, so the app still runs.
 */
export interface IpcServices {
  /** 08: `eli5:doc:regenerate-section`, `create-section-eli5`, `close-tab`, doc events. */
  sectionActions: SectionActions;
  /** 09 §10: `eli5:suggestions:*`. */
  suggestions: MergeSuggestions;
  /** 10: `eli5:publish:*`. */
  publish: PublishService;
  /** 11 §14: `eli5:app:test-notification`, `eli5:app:open-notification-settings`. */
  notifications: NotificationControls;
  /** 11 §7: `eli5:settings:choose-folder`. */
  folders: FolderChooser;
}

const notImplemented = (): never => fail('E_INTERNAL', 'Not implemented yet');
const noEvents = (): (() => void) => () => {};

export function notImplementedServices(): IpcServices {
  return {
    sectionActions: {
      regenerateSection: async () => notImplemented(),
      createSectionEli5: async () => notImplemented(),
      closeTab: async () => notImplemented(),
      onUpdated: noEvents,
      onScrollTo: noEvents,
      onSectionBusy: noEvents,
    },
    suggestions: {
      list: async () => notImplemented(),
      accept: async () => notImplemented(),
      dismiss: async () => notImplemented(),
      onChanged: noEvents,
      onDocUpdated: noEvents,
    },
    publish: {
      targets: async () => notImplemented(),
      run: async () => notImplemented(),
      history: async () => notImplemented(),
      cancel: async () => notImplemented(),
      copyLink: async () => notImplemented(),
      openLink: async () => notImplemented(),
      reveal: async () => notImplemented(),
      onProgress: noEvents,
    },
    notifications: {
      test: (): TestNotificationResult => notImplemented(),
      openSystemSettings: async () => notImplemented(),
    },
    folders: { chooseFolder: async () => notImplemented() },
  };
}
