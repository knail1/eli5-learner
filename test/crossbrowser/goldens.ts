/**
 * Shared helpers for the cross-browser specs (13 §7.2, §7.3): the golden documents as file:// URLs
 * and a page instrumented to record page errors, console errors, CSP violations and every request
 * that is not the document itself or a data: URI. Not a spec file itself (no `.spec.ts` suffix).
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';

export const GOLDEN_DIR = resolve(import.meta.dirname, '../fixtures/documents/build');

/** Every committed golden, so a new golden is covered without editing this list. */
export const GOLDENS: readonly { name: string; url: string }[] = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith('.html'))
  .sort()
  .map((f) => ({ name: f.replace(/\.html$/, ''), url: pathToFileURL(resolve(GOLDEN_DIR, f)).href }));

/** 07 §9.2 / doc-runtime GLOSSARY_QUERY: margin notes at >= 1100 px, collapsed below. */
export const WIDE = { width: 1280, height: 900 };
export const NARROW = { width: 800, height: 900 };

export interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  /** Requests other than the document itself and data: URIs; each is aborted. */
  requests: string[];
  /** Page errors, console errors and CSP violations reported by the page. */
  cspViolations(): Promise<string[]>;
}

/**
 * Instruments `page` before navigation. Every network request is routed and aborted, so nothing
 * can leave even if the document tried (13 §7.2); the attempt is recorded.
 */
export async function instrument(context: BrowserContext, page: Page, docUrl: string): Promise<Probe> {
  const probe: Probe = {
    pageErrors: [],
    consoleErrors: [],
    requests: [],
    cspViolations: () =>
      page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []),
  };
  const allowed = (url: string): boolean => url === docUrl || url.startsWith('data:');
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (allowed(url)) return route.continue();
    probe.requests.push(url);
    return route.abort('blockedbyclient');
  });
  page.on('request', (req) => {
    const url = req.url();
    if (!allowed(url) && !probe.requests.includes(url)) probe.requests.push(url);
  });
  page.on('pageerror', (e) => probe.pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') probe.consoleErrors.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations?: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__cspViolations?.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return probe;
}
