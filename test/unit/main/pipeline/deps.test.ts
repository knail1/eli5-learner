import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '../../../../src/main/config';
import { DEFAULTS, type Settings } from '../../../../src/main/config/schema';
import type { DocTheme } from '../../../../src/main/document';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import { Registry } from '../../../../src/main/editions/registry';
import { FakeProvider } from '../../../../src/main/llm/testing/fake';
import { createPipelineDeps, type PipelineElectron, type PipelineLibrary } from '../../../../src/main/pipeline';
import { tmpLibrary } from '../../../helpers/tmp-library';
import { defaultScript, REPO } from './harness';

const RESOURCES = path.join(REPO, 'resources');

function library(calls: string[] = []): PipelineLibrary & { runMergeCheck(id: string): Promise<null> } {
  const no = (): never => {
    throw new Error('not used');
  };
  return {
    root: '/nonexistent',
    readOnly: false,
    allocateSlug: no,
    commitDocument: no,
    stagingDir: no,
    withDocLock: no,
    docPath: no,
    getEntry: () => undefined,
    reconcile: async () => {},
    runMergeCheck: async (id) => {
      calls.push(id);
      return null;
    },
  };
}

function registry(settings: Settings, fake = new FakeProvider(defaultScript())): Registry {
  const reg = new Registry({ edition: 'public', getSettings: () => settings });
  registerPublicCapabilities(reg);
  reg.registerLLMProvider('claude', () => fake);
  return reg;
}

interface FakeChild {
  posted: unknown[];
  killed: boolean;
  handlers: Record<string, ((x: unknown) => void)[]>;
}

function fakeElectron(): PipelineElectron & {
  forks: { entry: string; opts: Record<string, unknown> }[];
  children: FakeChild[];
  power: string[];
} {
  const forks: { entry: string; opts: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  const power: string[] = [];
  return {
    forks,
    children,
    power,
    utilityProcess: {
      fork: (entry: string, _args?: string[], opts?: Record<string, unknown>) => {
        forks.push({ entry, opts: opts ?? {} });
        const child: FakeChild = { posted: [], killed: false, handlers: {} };
        children.push(child);
        return {
          postMessage: (m: unknown) => child.posted.push(m),
          on: (ev: string, cb: (x: unknown) => void) => {
            (child.handlers[ev] ??= []).push(cb);
          },
          kill: () => {
            child.killed = true;
            return true;
          },
        } as unknown as Electron.UtilityProcess;
      },
    },
    BrowserWindow: class {} as unknown as typeof Electron.BrowserWindow,
    MessageChannelMain: class {} as unknown as typeof Electron.MessageChannelMain,
    session: {} as unknown as typeof Electron.session,
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } as unknown as PipelineElectron['nativeImage'],
    powerSaveBlocker: {
      start: (type: string) => {
        power.push(`start:${type}`);
        return 7;
      },
      stop: (id: number) => {
        power.push(`stop:${id}`);
      },
    },
  };
}

describe('createPipelineDeps (06 §2, M1 handoff wiring)', () => {
  it('assembles tasks, prompts, skills, theme, key check and merge trigger from the registry', async () => {
    const { userData } = await tmpLibrary();
    const settings: Settings = { ...DEFAULTS };
    const fake = new FakeProvider(defaultScript());
    const reg = registry(settings, fake);
    const keys = new MemoryKeyStore();
    const merges: string[] = [];
    const rt = createPipelineDeps({
      registry: reg,
      settings: () => settings,
      keyStore: keys,
      library: library(merges),
      userData,
      resourcePath: (rel) => path.join(RESOURCES, rel),
      workerEntry: '/app/out/main/extract-worker.js',
      watchSkills: false,
      extractServices: {
        renderPdfPages: async () => [],
        normalizeImage: async () => ({ ok: false, code: 'corrupt' }),
      },
    });
    const d = rt.deps;
    expect(d.userData).toBe(userData);
    expect(d.policy).toBe(reg.pipelinePolicy());
    expect(d.resolvers().map((r) => r.id)).toEqual(reg.resolvers().map((r) => r.id));
    expect(d.llmInfo()).toEqual({ id: 'claude', model: 'fake-model' });
    // 06 §7.2: key presence is checked without a network request.
    expect(await d.hasApiKey?.()).toBe(false);
    await keys.set('llm.claude.apiKey', ['sk', 'ant', 'test', 'x'].join('-'));
    expect(await d.hasApiKey?.()).toBe(true);
    // Skill theme feeds the document theme (07 §11.3).
    const theme = d.docTheme();
    expect(theme.source).toBe('skill');
    expect(theme.theme.tokens['--accent']).toBe('#d97757');
    // The task functions run against the registry's provider with the bundled prompts.
    const summary = await d.tasks.summarize(
      { kind: 'indepth', title: 'T', dek: 'D', sections: [{ heading: 'H', blocks: [{ type: 'paragraph', md: 'x' }] }] },
      { clarifyingInput: '', signal: new AbortController().signal },
    );
    expect(summary.prompt).toBe('summary@1');
    expect(fake.calls.map((c) => c.taskId)).toEqual(['summary']);
    await d.onMergeCheck?.('doc-1');
    expect(merges).toEqual(['doc-1']);
    // No Electron: in-process extraction with the given services; no power blocker.
    expect(d.powerSave).toBeUndefined();
    const runner = d.createExtractRunner('01JX');
    expect(typeof runner.extract).toBe('function');
    runner.dispose();
    rt.dispose();
  });

  it('logs the resolved skill names once at startup, so a packaged build can prove skills loaded', async () => {
    const { userData } = await tmpLibrary();
    const settings: Settings = { ...DEFAULTS };
    const infos: [string, unknown][] = [];
    const noop = (): void => {};
    const rt = createPipelineDeps({
      registry: registry(settings),
      settings: () => settings,
      keyStore: new MemoryKeyStore(),
      library: library(),
      userData,
      resourcePath: (rel) => path.join(RESOURCES, rel),
      workerEntry: 'x',
      watchSkills: false,
      log: { info: (e, f) => infos.push([e, f]), warn: noop, error: noop, debug: noop },
      extractServices: {
        renderPdfPages: async () => [],
        normalizeImage: async () => ({ ok: false, code: 'corrupt' }),
      },
    });
    expect(infos).toContainEqual(['pipeline.skills-loaded', { count: 2, kind: 'beautiful-doc,eli5' }]);
    rt.dispose();
  });

  it('user skills override bundled ones; an overlay theme wins over the skill theme', async () => {
    const { userData } = await tmpLibrary();
    const settings: Settings = { ...DEFAULTS };
    const reg = registry(settings);
    const overlay: DocTheme = { id: 'org', version: '2', tokens: { '--accent': '#123456' }, footer: 'Org' };
    reg.registerDocTheme(overlay);
    const skillDir = path.join(userData, 'skills', 'beautiful-doc');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: beautiful-doc\n---\nUser style.\n');
    await writeFile(path.join(skillDir, 'theme.css'), ':root{--paper:#fefefe}');
    const rt = createPipelineDeps({
      registry: reg,
      settings: () => settings,
      keyStore: new MemoryKeyStore(),
      library: library(),
      userData,
      resourcePath: (rel) => path.join(RESOURCES, rel),
      workerEntry: 'x',
      watchSkills: false,
      requireApiKey: false,
      extractServices: {
        renderPdfPages: async () => [],
        normalizeImage: async () => ({ ok: false, code: 'corrupt' }),
      },
    });
    expect(rt.deps.hasApiKey).toBeUndefined();
    expect(rt.skills.forSlot('beautiful-doc')?.body).toContain('User style.');
    const t = rt.deps.docTheme();
    expect(t.source).toBe('overlay');
    expect(t.theme.tokens).toEqual({ '--paper': '#fefefe', '--accent': '#123456' });
    expect(t.theme.footer).toBe('Org');
    rt.dispose();
  });

  it('with Electron: extract worker via utilityProcess, per-job render window, power blocker', async () => {
    const { userData } = await tmpLibrary();
    const settings: Settings = { ...DEFAULTS };
    const electron = fakeElectron();
    const rt = createPipelineDeps({
      registry: registry(settings),
      settings: () => settings,
      keyStore: new MemoryKeyStore(),
      library: library(),
      userData,
      resourcePath: (rel) => path.join(RESOURCES, rel),
      workerEntry: '/app/out/main/extract-worker.js',
      pdfjsDir: '/app/resources/pdfjs',
      pdfjsWorkerSrc: 'eli5res://pdfjs/pdf.worker.mjs',
      electron,
      watchSkills: false,
    });
    const id = rt.deps.powerSave?.start();
    rt.deps.powerSave?.stop(id ?? -1);
    expect(electron.power).toEqual(['start:prevent-app-suspension', 'stop:7']);
    const runner = rt.deps.createExtractRunner('01JX');
    const { JobImageBudget, DEFAULT_EXTRACT_LIMITS } = await import('../../../../src/main/extract');
    const pending = runner.extract(
      {
        id: 'src-00',
        inputId: 'in-1',
        ref: 'a.txt',
        location: '/tmp/a.txt',
        lane: 'local',
        resolverId: 'file',
        format: 'text',
        mediaType: 'text/plain',
        payload: { kind: 'text', text: 'hello' },
        sizeBytes: 5,
        sha256: 'x',
        notes: [],
      },
      { signal: new AbortController().signal, limits: DEFAULT_EXTRACT_LIMITS, budget: new JobImageBudget() },
    );
    await Promise.resolve();
    expect(electron.forks).toHaveLength(1);
    expect(electron.forks[0]?.entry).toBe('/app/out/main/extract-worker.js');
    expect(electron.forks[0]?.opts.execArgv).toEqual(['--max-old-space-size=1024']);
    expect((electron.forks[0]?.opts.env as Record<string, string>).ELI5_PDFJS_WORKER_SRC).toBe(
      'eli5res://pdfjs/pdf.worker.mjs',
    );
    const child = electron.children[0];
    expect(child?.posted[0]).toMatchObject({ type: 'extract', source: { id: 'src-00' } });
    runner.dispose(); // job end: worker killed, in-flight source settles
    expect(child?.killed).toBe(true);
    expect(await pending).toMatchObject({ ok: false });
    rt.dispose();
  });
});
