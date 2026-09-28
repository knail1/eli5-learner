import path from 'node:path';
import { DEFAULTS, type Settings } from '../../../../src/main/config/schema';
import type { ProviderDeps } from '../../../../src/main/llm/base';
import { Limiter } from '../../../../src/main/llm/limiter';
import { cassetteFetch, type CassetteTransport } from '../../../../src/main/llm/testing/cassette';
import type { ProviderId } from '../../../../src/main/llm/types';

export const REPO = path.resolve(import.meta.dirname, '../../../..');
export const CASSETTES = path.join(REPO, 'test/fixtures/cassettes');
export const PROMPTS_DIR = path.join(REPO, 'resources/prompts');
export const SKILLS_DIR = path.join(REPO, 'resources/skills');

/** A key-shaped string assembled at runtime so the repo never contains a literal one (13 §11). */
export const TEST_KEY = ['sk', 'test', 'cassette', '0001'].join('-');

export function settingsFor(provider: ProviderId, model: string | null = null): Settings {
  return { ...DEFAULTS, llm: { ...DEFAULTS.llm, provider, model } };
}

export function cassette(rel: string): CassetteTransport {
  return cassetteFetch(path.join(CASSETTES, rel));
}

/** Deps with an instant, recorded sleep so retry schedules run without waiting. */
export function fastDeps(t: CassetteTransport, extra: Partial<ProviderDeps> = {}): ProviderDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    getApiKey: () => Promise.resolve(TEST_KEY),
    fetch: t.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    limiter: new Limiter(2, () => Promise.resolve()),
    sleeps,
    ...extra,
  };
}
