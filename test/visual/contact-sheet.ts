/**
 * Contact sheet reporter for the visual suite (13 §7.4). After every run it writes
 * test-results/visual/index.html: each failed comparison first, with expected, actual and diff side
 * by side, then every baseline of this platform with its name. The PNGs are copied next to it
 * (screens/ for the baselines, failures/ for the comparison images), so the folder is
 * self-contained: open it locally, or download it as the CI artifact. Nothing here decides
 * pass or fail; it only shows what the comparisons saw.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

const BASELINES = path.resolve(import.meta.dirname, '__screenshots__');
const OUT = path.resolve(import.meta.dirname, '../../test-results/visual');
const KINDS = ['expected', 'actual', 'diff'] as const;
type Kind = (typeof KINDS)[number];

interface Failure {
  /** Baseline file name: `<name>-<project>-<platform>.png`. */
  file: string;
  test: string;
  images: Partial<Record<Kind, string>>;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function baselineFiles(): { spec: string; file: string; abs: string }[] {
  if (!existsSync(BASELINES)) return [];
  const suffix = `-${process.platform}.png`;
  return readdirSync(BASELINES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(path.join(BASELINES, d.name))
        .filter((f) => f.endsWith(suffix))
        .sort()
        .map((f) => ({ spec: d.name, file: f, abs: path.join(BASELINES, d.name, f) })),
    );
}

/** `full-header-light-chromium-darwin.png` -> { project: 'chromium', name: 'full-header-light' }. */
function parse(file: string, projects: string[]): { project: string; name: string } {
  const stem = file.replace(new RegExp(`-${process.platform}\\.png$`), '');
  const project = projects.find((p) => stem.endsWith(`-${p}`)) ?? '';
  return { project, name: project ? stem.slice(0, -project.length - 1) : stem };
}

export default class ContactSheet implements Reporter {
  private readonly failures = new Map<string, Failure>();
  private readonly projects = new Set<string>(['chromium', 'webkit', 'app']);
  private passed = 0;
  private failed = 0;

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? '';
    if (project) this.projects.add(project);
    if (result.status === 'passed' || result.status === 'skipped') this.passed += result.status === 'passed' ? 1 : 0;
    else this.failed++;
    for (const a of result.attachments) {
      const m = /^(.*)-(expected|actual|diff)\.png$/.exec(a.name);
      if (!m || !a.path) continue;
      const [, name = '', kind] = m;
      const file = `${name}-${project}-${process.platform}.png`;
      const f = this.failures.get(file) ?? { file, test: test.titlePath().slice(1).join(' › '), images: {} };
      f.images[kind as Kind] = a.path;
      this.failures.set(file, f);
    }
  }

  onEnd(): void {
    rmSync(path.join(OUT, 'screens'), { recursive: true, force: true });
    rmSync(path.join(OUT, 'failures'), { recursive: true, force: true });
    mkdirSync(path.join(OUT, 'screens'), { recursive: true });
    mkdirSync(path.join(OUT, 'failures'), { recursive: true });

    const failures = [...this.failures.values()].sort((a, b) => a.file.localeCompare(b.file));
    const failureHtml = failures.map((f) => {
      const cells = KINDS.map((k) => {
        const src = f.images[k];
        if (!src || !existsSync(src)) return `<figure class="cell"><figcaption>${k}</figcaption><p>none</p></figure>`;
        const rel = `failures/${f.file.replace(/\.png$/, '')}-${k}.png`;
        copyFileSync(src, path.join(OUT, rel));
        return `<figure class="cell"><figcaption>${k}</figcaption><a href="${esc(rel)}"><img src="${esc(rel)}" alt="${esc(`${f.file} ${k}`)}"></a></figure>`;
      }).join('');
      return `<section class="fail"><h3>${esc(f.file)}</h3><p class="muted">${esc(f.test)}</p><div class="trio">${cells}</div></section>`;
    });

    const projects = [...this.projects];
    const groups = new Map<string, string[]>();
    const all = baselineFiles();
    for (const b of all) {
      copyFileSync(b.abs, path.join(OUT, 'screens', b.file));
      const { project, name } = parse(b.file, projects);
      const rel = `screens/${b.file}`;
      const bad = this.failures.has(b.file) ? ' bad' : '';
      const card = `<figure class="card${bad}" data-name="${esc(b.file)}"><a href="${esc(rel)}"><img loading="lazy" src="${esc(rel)}" alt="${esc(name)}"></a><figcaption><b>${esc(name)}</b><br><span class="muted">${esc(b.file)}</span></figcaption></figure>`;
      const key = `${b.spec} · ${project || 'other'}`;
      groups.set(key, [...(groups.get(key) ?? []), card]);
    }
    const gallery = [...groups.entries()]
      .map(
        ([k, cards]) =>
          `<h2>${esc(k)} <span class="muted">(${cards.length})</span></h2><div class="grid">${cards.join('')}</div>`,
      )
      .join('\n');

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual contact sheet</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--ink:#1b1b1f;--muted:#666;--line:#ddd;--bad:#c62828;--card:#f6f6f8}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--ink:#ececf0;--muted:#9a9aa2;--line:#333;--card:#202024}}
body{margin:0;padding:16px 24px 48px;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:14px;margin:0}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{margin:0;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px}
.card.bad{border:2px solid var(--bad)}
.card img{display:block;max-width:100%;max-height:360px;margin:0 auto;background:repeating-conic-gradient(#8881 0 25%,transparent 0 50%) 0 0/16px 16px}
.card figcaption{margin-top:6px;font-size:12px;word-break:break-all}
.fail{border:2px solid var(--bad);border-radius:6px;padding:10px;margin:12px 0}
.trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}
.cell{margin:0}.cell img{max-width:100%;display:block}.cell figcaption{font-weight:600;text-transform:uppercase;font-size:11px}
input{font:inherit;padding:4px 8px;width:min(100%,360px)}
</style></head><body>
<h1>Visual contact sheet</h1>
<p class="muted">${esc(new Date().toISOString())} · ${this.passed} tests passed, ${this.failed} failed · ${failures.length} failed comparisons · ${all.length} baselines (${esc(process.platform)}) in test/visual/__screenshots__/</p>
<p><input type="search" placeholder="Filter by name" aria-label="Filter by name" id="q"></p>
${failures.length ? `<h2>Failed comparisons (${failures.length})</h2>${failureHtml.join('\n')}` : '<p>No failed comparisons.</p>'}
${gallery}
<script>
document.getElementById('q').addEventListener('input',function(e){var q=e.target.value.toLowerCase();document.querySelectorAll('.card').forEach(function(c){c.hidden=q!==''&&c.getAttribute('data-name').toLowerCase().indexOf(q)<0})});
</script>
</body></html>
`;
    writeFileSync(path.join(OUT, 'index.html'), html);
    console.log(`Visual contact sheet: ${path.join(OUT, 'index.html')}`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
