import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULTS, SettingsError, SettingsStore } from '../../../../src/main/config';

let dir: string;
const file = () => path.join(dir, 'settings.json');
const readJson = async () => JSON.parse(await readFile(file(), 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'eli5-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsStore.load (12 §4.2)', () => {
  it('uses defaults when the file is missing and does not write', async () => {
    const s = new SettingsStore({ dir });
    await s.load();
    expect(s.get()).toEqual(DEFAULTS);
    await expect(stat(file())).rejects.toThrow();
  });

  it('resets only the invalid leaf and reports it', async () => {
    await writeFile(file(), JSON.stringify({ llm: { maxConcurrency: 99, provider: 'openai' } }));
    const s = new SettingsStore({ dir });
    await s.load();
    expect(s.get().llm.maxConcurrency).toBe(2);
    expect(s.get().llm.provider).toBe('openai');
    expect(s.loadIssues()).toContainEqual({ path: 'llm.maxConcurrency', reason: 'invalid' });
    expect((await readJson()).llm).toEqual({ provider: 'openai' });
  });

  it('drops unknown keys leaf by leaf', async () => {
    await writeFile(file(), JSON.stringify({ llm: { apiKeyz: 'x' }, glossary: { defaultOn: false } }));
    const s = new SettingsStore({ dir });
    await s.load();
    expect(s.get().glossary.defaultOn).toBe(false);
    expect(s.loadIssues().map((i) => i.path)).toContain('llm.apiKeyz');
  });

  it('moves a corrupt file aside and starts with defaults', async () => {
    await writeFile(file(), '{not json');
    const s = new SettingsStore({ dir, now: () => new Date('2026-01-01T00:00:00Z') });
    await s.load();
    expect(s.get()).toEqual(DEFAULTS);
    expect(s.loadIssues()).toContainEqual({ path: '', reason: 'corrupt-file' });
    expect((await readdir(dir)).some((f) => f.startsWith('settings.corrupt-'))).toBe(true);
  });

  it('removes secret-shaped values without logging them', async () => {
    const fake = ['sk', 'ant', 'x'.repeat(30)].join('-');
    await writeFile(file(), JSON.stringify({ publish: { github: { note: fake } } }));
    const events: string[] = [];
    const s = new SettingsStore({ dir, onIssue: (e, f) => events.push(`${e}:${JSON.stringify(f)}`) });
    await s.load();
    expect(s.get().publish.github).toEqual({});
    expect(events.join()).not.toContain(fake);
    expect(await readFile(file(), 'utf8')).not.toContain(fake);
  });

  it('round-trips dormant namespaces unchanged', async () => {
    const dormant = { publish: { drive: { folder: 'Team/Docs', nested: { a: [1, 2] } } }, enterprise: { flag: true } };
    await writeFile(file(), JSON.stringify({ schemaVersion: 1, ...dormant }, null, 2));
    const s = new SettingsStore({ dir });
    await s.load();
    expect(s.get().publish.drive).toEqual(dormant.publish.drive);
    await s.set({ glossary: { defaultOn: false } });
    const saved = await readJson();
    expect(saved.publish).toEqual(dormant.publish);
    expect(saved.enterprise).toEqual(dormant.enterprise);
  });

  it('loads a newer schemaVersion read-compatibly without saving', async () => {
    const body = JSON.stringify({ schemaVersion: 9, llm: { provider: 'openai' }, futureKey: 1 });
    await writeFile(file(), body);
    const s = new SettingsStore({ dir });
    await s.load();
    expect(s.get().llm.provider).toBe('openai');
    expect(await readFile(file(), 'utf8')).toBe(body);
  });
});

describe('SettingsStore.set (12 §5.1)', () => {
  it('saves the user layer with mode 0600 and emits changed paths', async () => {
    const s = new SettingsStore({ dir });
    await s.load();
    const changes: string[][] = [];
    s.onChanged((_n, c) => changes.push(c));
    await s.set({ glossary: { defaultOn: false } });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await readJson()).toEqual({ schemaVersion: 1, glossary: { defaultOn: false } });
    expect(changes).toEqual([['glossary.defaultOn']]);
  });

  it('rejects unknown keys, invalid values and secrets without applying', async () => {
    const s = new SettingsStore({ dir });
    await s.load();
    await expect(s.set({ llm: { apiKey: 'x' } } as never)).rejects.toMatchObject({ code: 'E_SETTINGS_INVALID' });
    await expect(s.set({ llm: { maxConcurrency: 0 } })).rejects.toMatchObject({ code: 'E_SETTINGS_INVALID' });
    const tok = ['gh', 'p_', 'a'.repeat(36)].join('');
    await expect(s.set({ publish: { github: { t: tok } } })).rejects.toMatchObject({ code: 'E_SECRET_IN_SETTINGS' });
    expect(s.get()).toEqual(DEFAULTS);
  });

  it('rejects an unavailable provider', async () => {
    const s = new SettingsStore({ dir, isProviderAvailable: (id) => id !== 'bedrock' });
    await s.load();
    const err = await s.set({ llm: { provider: 'bedrock' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).code).toBe('E_SETTINGS_INVALID');
  });
});

describe('SettingsExtension (12 §8.2, HOOK-CFG-01)', () => {
  it('applies precedence defaults < user < managed and locks managed paths', async () => {
    await writeFile(file(), JSON.stringify({ llm: { maxConcurrency: 3 }, glossary: { defaultOn: false } }));
    const s = new SettingsStore({ dir });
    await s.load();
    await s.applyExtension({
      id: 'test',
      defaults: { llm: { maxConcurrency: 4, timeoutMs: 60_000 } },
      managed: { glossary: { defaultOn: true } },
    });
    expect(s.get().llm.maxConcurrency).toBe(3);
    expect(s.get().llm.timeoutMs).toBe(60_000);
    expect(s.get().glossary.defaultOn).toBe(true);
    await expect(s.set({ glossary: { defaultOn: false } })).rejects.toMatchObject({ code: 'E_SETTINGS_LOCKED' });
    const d = s.describe(true);
    expect(d.keys.find((k) => k.path === 'glossary.defaultOn')).toMatchObject({ locked: true, source: 'managed' });
    expect(d.keys.find((k) => k.path === 'llm.timeoutMs')).toMatchObject({ source: 'extension' });
  });

  it('gives a dormant namespace a strict schema and resets values that fail it', async () => {
    await writeFile(file(), JSON.stringify({ publish: { github: { repo: 42 } } }));
    const s = new SettingsStore({ dir });
    await s.load();
    await s.applyExtension({
      id: 'test',
      schemas: { 'publish.github': z.object({ repo: z.string().optional() }).strict().prefault({}) },
    });
    expect(s.get().publish.github).toEqual({});
    expect(s.loadIssues().map((i) => i.path)).toContain('publish.github.repo');
  });

  it('fails closed on secrets in extension layers', async () => {
    const s = new SettingsStore({ dir });
    await s.load();
    const fake = ['sk', 'ant', 'y'.repeat(30)].join('-');
    await expect(s.applyExtension({ id: 'bad', defaults: { enterprise: { k: fake } } })).rejects.toThrow(/secret/);
  });
});
