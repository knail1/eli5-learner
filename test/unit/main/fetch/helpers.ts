import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, type Limits } from '../../../../src/main/fetch/constants';
import { createFetcher, type FetcherDeps } from '../../../../src/main/fetch/fetcher';
import { requestHeaders } from '../../../../src/main/fetch/network';
import { Politeness } from '../../../../src/main/fetch/politeness';
import { inProcessReadability } from '../../../../src/main/fetch/readability';
import { nodeTransport } from '../../../../src/main/fetch/node-transport';
import type { FetchContext } from '../../../../src/main/fetch/types';

/** TEST-NET-3 address: "public" for the private-address guard, never contacted. */
export const PUBLIC_IP = '203.0.113.10';

export function testLimits(over: Partial<Limits> = {}): Limits {
  return { ...LIMITS, ...over };
}

export function makeFetcher(over: Partial<FetcherDeps> = {}) {
  return createFetcher({
    transport: nodeTransport(),
    headers: requestHeaders('Mozilla/5.0 TestChromium ELI5Learner/0.0.0', ['en-US', 'fr']),
    readability: inProcessReadability,
    lookup: async () => [PUBLIC_IP],
    politeness: new Politeness({ hostIntervalMs: 0 }),
    sleep: async () => {},
    ...over,
  });
}

export async function tmpStaging(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eli5-fetch-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function ctxFor(
  stagingDir: string,
  signal: AbortSignal = new AbortController().signal,
  jobId = 'job-1',
): FetchContext {
  return { jobId, signal, stagingDir };
}

/** A longer synthetic article body (≥ 1 500 chars) for rendered-page fakes. */
export function articleHtml(title = 'Widget Report', paragraphs = 8): string {
  const p =
    'Example Widgets Inc. measured every widget that left the plant this quarter and found that the new presses ' +
    'produce parts that are more uniform, lighter and cheaper to make than the ones made on the old line. ';
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><article><h1>${title}</h1>` +
    Array.from({ length: paragraphs }, (_, i) => `<p>${p}Finding ${i + 1}.</p>`).join('') +
    '</article></main></body></html>'
  );
}
