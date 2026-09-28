/** Public SourceResolver implementations under the shared contract (13 §10.2). */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchOutcome } from '../../src/main/fetch';
import { ClipboardResolver, FileResolver, UrlResolver, type SourceInput } from '../../src/main/sources';
import { describeSourceResolverContract, findCredentialLike } from './source-resolver.contract';

let root = '';
const staging = () => path.join(root, 'jobs', 'job-contract');

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'eli5-contract-'));
  await mkdir(path.join(staging(), 'inputs'), { recursive: true });
  await mkdir(path.join(staging(), 'downloads'), { recursive: true });
  await writeFile(path.join(root, 'notes.md'), '# Example Widgets Inc.\n\n- Revenue grew\n');
  await writeFile(path.join(root, 'memo.rtf'), '{\\rtf1 Example Widgets Inc.}');
  await mkdir(path.join(root, 'Folder'), { recursive: true });
  await writeFile(path.join(root, 'Folder', 'a.txt'), 'Example Widgets Inc. folder note\n');
  await writeFile(path.join(staging(), 'inputs', '0-pasted-1.txt'), 'Example Widgets Inc. pasted text\n');
  await writeFile(
    path.join(staging(), 'inputs', '1-pasted-2.png'),
    Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
  );
  await writeFile(path.join(staging(), 'downloads', '0-report.pdf'), '%PDF-1.4\n%%EOF\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const fileIn = (rel: string): SourceInput => ({
  id: 'in-0000c001',
  kind: 'file',
  origin: 'drop',
  path: path.join(root, rel),
});

describeSourceResolverContract('file', async () => new FileResolver(), [
  { name: 'markdown file', setup: async () => ({ input: fileIn('notes.md') }), expect: 'resolved' },
  { name: 'folder', setup: async () => ({ input: fileIn('Folder') }), expect: 'resolved' },
  { name: 'unsupported RTF', setup: async () => ({ input: fileIn('memo.rtf') }), expect: 'skipped' },
  { name: 'missing file', setup: async () => ({ input: fileIn('missing.pdf') }), expect: 'skipped' },
]);

describeSourceResolverContract('clipboard', async () => new ClipboardResolver(), [
  {
    name: 'pasted plain text',
    setup: async () => ({
      input: {
        id: 'in-0000c002',
        kind: 'text',
        origin: 'paste',
        stagedPath: path.join(staging(), 'inputs', '0-pasted-1.txt'),
        markup: 'plain',
        preview: 'Pasted text: Example Widgets Inc.…',
      },
      ctx: { stagingDir: staging() },
    }),
    expect: 'resolved',
  },
  {
    name: 'pasted screenshot',
    setup: async () => ({
      input: {
        id: 'in-0000c003',
        kind: 'image',
        origin: 'paste',
        stagedPath: path.join(staging(), 'inputs', '1-pasted-2.png'),
        mediaType: 'image/png',
        preview: 'Pasted image 14:02',
      },
      ctx: { stagingDir: staging() },
    }),
    expect: 'resolved',
  },
  {
    name: 'staged paste no longer available',
    setup: async () => ({
      input: {
        id: 'in-0000c004',
        kind: 'text',
        origin: 'paste',
        stagedPath: path.join(staging(), 'inputs', 'gone.txt'),
        markup: 'plain',
        preview: 'Pasted text: gone',
      },
      ctx: { stagingDir: staging() },
    }),
    expect: 'skipped',
  },
]);

const urlIn = (url: string): SourceInput => ({ id: 'in-0000c005', kind: 'url', origin: 'url-field', url });

/** Fake fetch lane (05 is injected; 03 §15) that also honors the abort signal. */
function fakeFetch(outcome: () => FetchOutcome) {
  return (_url: string, fctx: { signal: AbortSignal }): Promise<FetchOutcome> =>
    new Promise((resolve, reject) => {
      if (fctx.signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const t = setTimeout(() => resolve(outcome()), 20);
      fctx.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
}

describeSourceResolverContract('url', async () => new UrlResolver(), [
  {
    name: 'article',
    setup: async () => ({
      input: urlIn('https://example.com/post'),
      ctx: {
        fetchUrl: fakeFetch(() => ({
          kind: 'article',
          content: {
            requestedUrl: 'https://example.com/post',
            finalUrl: 'https://example.com/post',
            title: 'Example Widgets Inc.',
            byline: null,
            siteName: null,
            lang: null,
            publishedTime: null,
            excerpt: null,
            contentHtml: '<p>Example Widgets Inc.</p>',
            textLength: 20,
            via: 'http',
            imageUrls: [],
          },
        })),
      },
    }),
    expect: 'resolved',
  },
  {
    name: 'binary download',
    setup: async () => ({
      input: urlIn('https://example.com/report.pdf'),
      ctx: {
        stagingDir: staging(),
        fetchUrl: fakeFetch(() => ({
          kind: 'binary',
          content: {
            requestedUrl: 'https://example.com/report.pdf',
            finalUrl: 'https://example.com/report.pdf',
            mime: 'application/pdf',
            filename: 'report.pdf',
            path: path.join(staging(), 'downloads', '0-report.pdf'),
            sizeBytes: 15,
          },
        })),
      },
    }),
    expect: 'resolved',
  },
  {
    name: 'login wall',
    setup: async () => ({
      input: urlIn('https://example.com/private'),
      ctx: { fetchUrl: fakeFetch(() => ({ kind: 'skipped', code: 'login-required', reason: 'page required login' })) },
    }),
    expect: 'skipped',
  },
]);

describe('findCredentialLike', () => {
  it('detects token-shaped strings assembled at runtime and ignores ordinary text', async () => {
    const token = ['sk', 'ant', 'x'.repeat(24)].join('-');
    expect(findCredentialLike(`key=${token}`)).toBe(token);
    expect(findCredentialLike(await readFile(path.join(root, 'notes.md'), 'utf8'))).toBeNull();
  });
});
