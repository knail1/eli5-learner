import type { HelpTopic } from '../../preload/contract';

/**
 * Help links (11 §7 Publishing and About; HOOK-UI-02 public behavior): the public README and the
 * bundled files under resources/. Topics map to fixed files, so no renderer-supplied path is opened.
 * Bundled pages open with the default app (the Pages help is self-contained and offline, 10 §8).
 */

export const PUBLIC_README_URL = 'https://github.com/knail1/eli5-learner#readme';

/** Paths relative to the resources folder. */
export const HELP_FILES: Record<Exclude<HelpTopic, 'readme'>, string> = {
  'publish-pages': 'help/publish-github-pages.html',
  licenses: 'skills/THIRD_PARTY.md',
};

export interface HelpOpenerDeps {
  /** config `resourcePath` (dev: <app>/resources, packaged: Contents/Resources). */
  resourcePath(rel: string): string;
  exists(p: string): Promise<boolean>;
  /** `shell.openPath`: resolves to an error string, empty on success. */
  openPath(p: string): Promise<string>;
  showItemInFolder(p: string): void;
  /** The guarded opener (12 §7.5); false when it refused. */
  openExternal(url: string): Promise<boolean>;
}

export interface HelpOpener {
  /** False when the topic's file is missing or the link was refused. */
  open(topic: HelpTopic): Promise<boolean>;
}

export function createHelpOpener(d: HelpOpenerDeps): HelpOpener {
  return {
    async open(topic) {
      if (topic === 'readme') return d.openExternal(PUBLIC_README_URL);
      const file = d.resourcePath(HELP_FILES[topic]);
      if (!(await d.exists(file))) return false;
      // No app registered for the type (e.g. .md): show the file in Finder instead.
      if (await d.openPath(file)) d.showItemInFolder(file);
      return true;
    },
  };
}
