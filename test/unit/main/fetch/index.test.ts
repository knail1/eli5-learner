import { afterEach, describe, expect, it, vi } from 'vitest';
import { endFetchJob, fetchBytes, fetchUrl, setFetcher, type Fetcher } from '../../../../src/main/fetch';

afterEach(() => setFetcher(null));

describe('fetch module entry (05 §2)', () => {
  it('fetchUrl and endFetchJob delegate to the process-wide fetcher', async () => {
    const f: Fetcher = {
      fetchUrl: vi.fn(async () => ({ kind: 'skipped' as const, code: 'invalid-url' as const, reason: 'x' })),
      endJob: vi.fn(async () => {}),
      fetchBytes: vi.fn(async () => ({ kind: 'skipped' as const, code: 'timeout' as const })),
    };
    setFetcher(f);
    const ctx = { jobId: 'j', signal: new AbortController().signal, stagingDir: '/tmp/x' };
    await expect(fetchUrl('https://site.example/', ctx)).resolves.toMatchObject({ kind: 'skipped' });
    expect(f.fetchUrl).toHaveBeenCalledWith('https://site.example/', ctx);
    await endFetchJob('j');
    expect(f.endJob).toHaveBeenCalledWith('j');
    const o = { signal: ctx.signal, accept: 'image/*', maxBytes: 10 };
    await expect(fetchBytes('https://img.example/a.jpg', o)).resolves.toMatchObject({ code: 'timeout' });
    expect(f.fetchBytes).toHaveBeenCalledWith('https://img.example/a.jpg', o);
  });
});
