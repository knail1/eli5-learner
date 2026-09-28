import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseYamlSubset } from './yaml-subset';
import type { YamlValue } from './yaml-subset';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

type Obj = { [key: string]: YamlValue };
const obj = (v: YamlValue | undefined): Obj => {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected a map');
  return v;
};
const arr = (v: YamlValue | undefined): YamlValue[] => {
  if (!Array.isArray(v)) throw new Error('expected a sequence');
  return v;
};

describe('parseYamlSubset', () => {
  it('parses maps, sequences of maps, block scalars and flow sequences', () => {
    const y = parseYamlSubset(
      [
        '# c',
        'a: 1',
        'b:',
        '  - x',
        '  - k: v',
        '    n: "q: r"',
        'c: [one, two]',
        'd: |',
        '  line 1',
        '    line 2',
        'e:',
        '- f',
      ].join('\n'),
    );
    expect(y).toEqual({
      a: 1,
      b: ['x', { k: 'v', n: 'q: r' }],
      c: ['one', 'two'],
      d: 'line 1\n  line 2\n',
      e: ['f'],
    });
  });

  it('rejects duplicate keys, tabs and inline comments', () => {
    expect(() => parseYamlSubset('a: 1\na: 2')).toThrow(/duplicate/);
    expect(() => parseYamlSubset('a:\n\t- x')).toThrow(/tabs/);
    expect(() => parseYamlSubset('a: b # c')).toThrow(/inline comments/);
  });

  it('reads the existing Pages workflow', () => {
    const pages = obj(parseYamlSubset(read('.github/workflows/pages.yml')));
    expect(Object.keys(obj(pages.jobs))).toEqual(['deploy']);
  });
});

describe('.github/workflows/ci.yml (13 §12)', () => {
  const text = read('.github/workflows/ci.yml');
  const wf = obj(parseYamlSubset(text));
  const jobs = obj(wf.jobs);
  const job = (id: string): Obj => obj(jobs[id]);
  const steps = (id: string): Obj[] => arr(job(id).steps).map(obj);
  const runs = (id: string): string =>
    steps(id)
      .map((s) => (typeof s.run === 'string' ? s.run : ''))
      .join('\n');
  const uses = (id: string): string[] => steps(id).flatMap((s) => (typeof s.uses === 'string' ? [s.uses] : []));

  it('triggers on push to main, pull requests, a nightly schedule and dispatch; never pull_request_target', () => {
    const on = obj(wf.on);
    expect(Object.keys(on).sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch']);
    expect(obj(on.push).branches).toEqual(['main']);
    expect(arr(on.schedule).map((s) => typeof obj(s).cron)).toEqual(['string']);
    expect(text).not.toContain('pull_request_target');
  });

  it('grants contents: read at workflow level only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('defines exactly the §12 jobs, all on macOS runners', () => {
    expect(Object.keys(jobs)).toEqual([
      'static',
      'unit',
      'build-public',
      'e2e',
      'edition-fixture',
      'hygiene',
      'package',
      'evals',
    ]);
    for (const id of Object.keys(jobs)) expect(job(id)['runs-on'], id).toBe('macos-latest');
  });

  it('installs Node from .nvmrc with npm ci and an npm cache in every job', () => {
    for (const id of Object.keys(jobs)) {
      const setup = steps(id).find((s) => String(s.uses).startsWith('actions/setup-node@'));
      expect(setup, id).toBeDefined();
      expect(obj(setup?.with), id).toMatchObject({ 'node-version-file': '.nvmrc', cache: 'npm' });
      expect(runs(id), id).toMatch(/^npm ci$/m);
    }
  });

  it('caches the Electron and Playwright binaries keyed by the lockfile', () => {
    const caches = Object.keys(jobs).flatMap((id) =>
      steps(id).filter((s) => String(s.uses).startsWith('actions/cache@')),
    );
    const paths = caches.map((s) => String(obj(s.with).path));
    expect(paths.some((p) => p.includes('Caches/electron'))).toBe(true);
    expect(paths.some((p) => p.includes('ms-playwright'))).toBe(true);
    for (const s of caches) expect(String(obj(s.with).key)).toContain("hashFiles('package-lock.json')");
  });

  it('static runs typecheck, lint, prettier, the dependency audit and the license check', () => {
    const r = runs('static');
    for (const cmd of [
      'npm run typecheck',
      'npm run lint',
      'npx prettier --check .',
      'npm audit --omit=dev',
      'node scripts/check-licenses.mjs --audit',
      'node scripts/check-licenses.mjs\n',
      'node scripts/check-spec-hooks.mjs',
    ]) {
      expect(r + '\n', cmd).toContain(cmd);
    }
  });

  it('enforces the 13 §3.1 per-directory line coverage floors in vitest.config.ts', async () => {
    const cfg = (await import('../../../vitest.config')).default as {
      test?: { coverage?: { thresholds?: Record<string, unknown> } };
    };
    const t = cfg.test?.coverage?.thresholds ?? {};
    const floors: Record<string, number> = {
      'src/main/extract/**': 85,
      'src/main/document/**': 85,
      'src/main/library/**': 85,
      'src/main/pipeline/**': 85,
      'src/main/config/**': 85,
      'src/main/editions/**': 85,
      'src/main/sources/**': 75,
      'src/main/fetch/**': 75,
      'src/main/publish/**': 75,
      'src/main/llm/**': 75,
      'src/doc-runtime/**': 80,
    };
    for (const [glob, lines] of Object.entries(floors)) expect(t[glob], glob).toEqual({ lines });
  });

  it('unit runs the offline Vitest projects with coverage and uploads the report', () => {
    const r = runs('unit');
    expect(r).toContain('npx vitest run');
    for (const p of ['unit', 'integration', 'renderer', 'contracts:public']) expect(r).toContain(`--project ${p}`);
    expect(r).toContain('--coverage');
    expect(uses('unit').some((u) => u.startsWith('actions/upload-artifact@'))).toBe(true);
  });

  it('build-public asserts no overlay, builds, and uploads out/', () => {
    const r = runs('build-public');
    expect(r).toContain('test ! -e enterprise');
    expect(r.indexOf('test ! -e enterprise')).toBeLessThan(r.indexOf('npm run build'));
    const up = steps('build-public').find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
    expect(obj(up?.with)).toMatchObject({ name: 'out', path: 'out/' });
  });

  it('e2e and hygiene run after build-public', () => {
    expect(job('e2e').needs).toBe('build-public');
    expect(job('hygiene').needs).toBe('build-public');
    expect(runs('e2e')).toContain('npx playwright install chromium webkit');
    expect(runs('e2e')).toContain('npm run test:e2e');
    const failUpload = steps('e2e').find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
    expect(failUpload?.if).toBe('failure()');
  });

  it('edition-fixture builds cell F and proves F-missing fails with the 01 §6.5 message', () => {
    const r = runs('edition-fixture');
    expect(r).toContain('ELI5_EDITION=enterprise ELI5_OVERLAY_DIR=test/fixtures/overlay-fake npx electron-vite build');
    expect(r).toContain('requires an overlay');
  });

  it('edition-fixture proves the bundle check rejects the cell F build (13 §11 rule 4)', () => {
    const r = runs('edition-fixture');
    expect(r).toContain('overlay-fake npx electron-vite build');
    expect(r).toContain('npx jiti scripts/check-hygiene.ts --out out >');
    expect(r).toContain('@eli5/overlay resolved');
    expect(r.indexOf('check-hygiene.ts')).toBeGreaterThan(r.indexOf('overlay-fake npx electron-vite build'));
  });

  it('hygiene checks the downloaded package build with the deny-list secret', () => {
    const r = runs('hygiene');
    expect(r).toContain('npx jiti scripts/check-hygiene.ts --out out --package');
    expect(uses('hygiene').some((u) => u.startsWith('actions/download-artifact@'))).toBe(true);
    const step = steps('hygiene').find((s) => String(s.run).includes('check-hygiene.ts'));
    expect(obj(step?.env).ELI5_HYGIENE_DENYLIST).toBe('${{ secrets.ELI5_HYGIENE_DENYLIST }}');
    expect(r).toContain('gitleaks');
  });

  it('package runs only on pushes to main after every other gate, unsigned, 7-day artifact', () => {
    const p = job('package');
    expect(p.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(p.needs).toEqual(['static', 'unit', 'build-public', 'e2e', 'edition-fixture', 'hygiene']);
    expect(runs('package')).toContain('electron-builder --mac dmg');
    const up = steps('package').find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
    expect(obj(up?.with)['retention-days']).toBe(7);
    expect(obj(p.env).CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
  });

  it('evals run only on schedule or dispatch, with issues: write and the provider secrets', () => {
    const e = job('evals');
    expect(e.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(e.permissions).toEqual({ contents: 'read', issues: 'write' });
    const env = obj(e.env);
    expect(env.ANTHROPIC_API_KEY).toBe('${{ secrets.ANTHROPIC_API_KEY }}');
    expect(env.OPENAI_API_KEY).toBe('${{ secrets.OPENAI_API_KEY }}');
  });

  it('keeps the nightly schedule to evals', () => {
    for (const id of Object.keys(jobs).filter((j) => j !== 'evals' && j !== 'package')) {
      expect(job(id).if, id).toBeDefined();
      expect(String(job(id).if), id).toContain("github.event_name != 'schedule'");
    }
  });

  it('references only the deny-list and eval-key secrets', () => {
    const secrets = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(['ELI5_HYGIENE_DENYLIST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']));
  });
});
