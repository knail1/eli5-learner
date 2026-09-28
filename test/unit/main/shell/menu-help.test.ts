import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HELP_FILES, PUBLIC_README_URL, createHelpOpener } from '../../../../src/main/shell/menu-help';

/**
 * Help links (11 §7 Publishing and About, HOOK-UI-02): the renderer names a topic, main resolves
 * it to a fixed bundled file or the public README. The renderer never supplies a path or URL.
 */

const RES = '/app/resources';

function setup(over: { exists?: boolean; openPathError?: string } = {}) {
  const deps = {
    resourcePath: (rel: string) => path.join(RES, rel),
    exists: vi.fn(async () => over.exists ?? true),
    openPath: vi.fn(async () => over.openPathError ?? ''),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(async () => true),
  };
  return { deps, help: createHelpOpener(deps) };
}

describe('createHelpOpener (11 §7, HOOK-UI-02)', () => {
  it('opens the bundled Pages help page (10 §8) with the default app', async () => {
    const { deps, help } = setup();
    expect(await help.open('publish-pages')).toBe(true);
    expect(deps.openPath).toHaveBeenCalledWith(path.join(RES, 'help', 'publish-github-pages.html'));
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('opens the third-party license notices for the bundled skills', async () => {
    const { deps, help } = setup();
    expect(await help.open('licenses')).toBe(true);
    expect(deps.openPath).toHaveBeenCalledWith(path.join(RES, 'skills', 'THIRD_PARTY.md'));
  });

  it('reveals the file in Finder when no app can open it', async () => {
    const { deps, help } = setup({ openPathError: 'No application knows how to open this file' });
    expect(await help.open('licenses')).toBe(true);
    expect(deps.showItemInFolder).toHaveBeenCalledWith(path.join(RES, 'skills', 'THIRD_PARTY.md'));
  });

  it('answers false when the bundled file is missing, opening nothing', async () => {
    const { deps, help } = setup({ exists: false });
    expect(await help.open('publish-pages')).toBe(false);
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });

  it('opens the public README in the browser through the guarded opener', async () => {
    const { deps, help } = setup();
    expect(await help.open('readme')).toBe(true);
    expect(deps.openExternal).toHaveBeenCalledWith(PUBLIC_README_URL);
    expect(PUBLIC_README_URL).toMatch(/^https:\/\//);
    deps.openExternal.mockResolvedValueOnce(false);
    expect(await help.open('readme')).toBe(false);
  });

  it('maps only the fixed topics to files inside resources/', () => {
    expect(Object.keys(HELP_FILES).sort()).toEqual(['licenses', 'publish-pages']);
    for (const rel of Object.values(HELP_FILES)) expect(rel).not.toMatch(/\.\.|^\//);
  });
});
