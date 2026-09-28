import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocProtocolHandler } from '../../../../src/main/library';

/** The Pages setup help page (10 §8), served as eli5doc://help/publish-github-pages.html (12 §7.7). */

const repo = path.resolve(import.meta.dirname, '../../../..');
const helpRoot = path.join(repo, 'resources/help');
const page = () => readFile(path.join(helpRoot, 'publish-github-pages.html'), 'utf8');
const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

describe('resources/help/publish-github-pages.html (10 §8)', () => {
  it('is served by the eli5doc://help handler', async () => {
    const handler = createDocProtocolHandler({ root: '/nonexistent', isCatalogued: () => false, helpRoot });
    const res = await handler(new Request('eli5doc://help/publish-github-pages.html'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(await page());
  });

  it('is a self-contained HTML page that makes no network requests', async () => {
    const html = await page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<meta charset="utf-8"\s*\/?>/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<(img|iframe|video|audio|source|object|embed)\b/i);
    expect(html).not.toMatch(/@import|url\(/i);
    // No attribute points anywhere: URLs appear only as code text.
    expect(html).not.toMatch(/\b(src|href|action|srcset)\s*=\s*["']?(https?:|\/\/)/i);
  });

  it('follows the §8 outline in order', async () => {
    const headings = [...(await page()).matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1] ?? '').trim());
    expect(headings).toEqual([
      '1. What you get',
      '2. Prerequisites',
      '3. Create or choose the repository and folder',
      '4. Enable Pages with Actions as the source',
      '5. Add the workflow',
      '6. Branch protection and required reviews',
      '7. Keep private material out',
      '8. Custom domain (optional)',
      '9. Configure the app',
      '10. Verify',
      '11. Troubleshooting',
    ]);
  });

  it('carries the generic workflow with the same action versions as this repository', async () => {
    const body = text(await page());
    const workflow = await readFile(path.join(repo, '.github/workflows/pages.yml'), 'utf8');
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses).toHaveLength(4);
    for (const u of uses) expect(body).toContain(`uses: ${u}`);
    for (const line of [
      'name: Deploy docs to GitHub Pages',
      'paths: ["docs/**", ".github/workflows/pages.yml"]',
      'pages: write',
      'id-token: write',
      'group: pages',
      'path: docs',
      'url: ${{ steps.deployment.outputs.page_url }}',
    ]) {
      expect(body).toContain(line);
    }
  });

  it('covers the plan note, .nojekyll, the allowlist, settings mapping and troubleshooting', async () => {
    const body = text(await page());
    expect(body).toContain('.nojekyll');
    expect(body).toContain('Source: GitHub Actions');
    expect(body).toMatch(/GitHub Free[^.]*public repository/);
    expect(body).toContain('!docs/index.html');
    for (const key of [
      'publish.github.repo',
      'publish.github.branch',
      'publish.github.docsPath',
      'publish.github.pagesUrlPattern',
    ]) {
      expect(body).toContain(key);
    }
    expect(body).toMatch(/enterprise edition/i);
    expect(body).toContain('https://<owner>.github.io/<repo>/<slug>/');
    expect(body).toMatch(/404/);
    expect(body).toMatch(/non-fast-forward/);
  });

  it('names no organization, person, credential or private host', async () => {
    const html = await page();
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // no email addresses
    expect(html).not.toMatch(/knail1|internal|intranet|corp\b/i);
    expect(html).not.toMatch(/\b(gh[pos]_|github_pat_)[A-Za-z0-9]/);
    expect(html).not.toMatch(/HOOK-/);
  });
});
