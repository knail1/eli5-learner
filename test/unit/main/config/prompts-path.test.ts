import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initPaths, promptsPath, resolvePromptSet } from '../../../../src/main/config/paths';
import { DEFAULTS, SettingsSchema } from '../../../../src/main/config/schema';

describe('prompt catalogue location and set selection (02 §9, D4)', () => {
  it('promptsPath is config/prompts in dev and Resources/prompts packaged', () => {
    initPaths({ isPackaged: false, resourcesPath: '/R', appPath: '/repo' });
    expect(promptsPath()).toBe(path.join('/repo', 'config', 'prompts'));
    initPaths({ isPackaged: true, resourcesPath: '/R', appPath: '/repo' });
    expect(promptsPath()).toBe(path.join('/R', 'prompts'));
  });

  it('ELI5_PROMPT_SET (unpackaged only) > settings llm.promptSet > default', () => {
    const s = (promptSet?: string) => ({ llm: { ...(promptSet ? { promptSet } : {}) } });
    expect(resolvePromptSet(s(), {}, false)).toBe('default');
    expect(resolvePromptSet(s('wsj-v1'), {}, false)).toBe('wsj-v1');
    expect(resolvePromptSet(s('wsj-v1'), { ELI5_PROMPT_SET: 'trial' }, false)).toBe('trial');
    expect(resolvePromptSet(s('wsj-v1'), { ELI5_PROMPT_SET: 'trial' }, true)).toBe('wsj-v1');
    expect(resolvePromptSet(s(), { ELI5_PROMPT_SET: '  ' }, false)).toBe('default');
  });

  it('settings llm.promptSet defaults to "default" and accepts only set names', () => {
    expect(DEFAULTS.llm.promptSet).toBe('default');
    expect(SettingsSchema.safeParse({ llm: { promptSet: 'wsj-v1' } }).success).toBe(true);
    for (const bad of ['../x', 'Upper', '', 'a'.repeat(41), 'a/b'])
      expect(SettingsSchema.safeParse({ llm: { promptSet: bad } }).success, bad).toBe(false);
  });
});
