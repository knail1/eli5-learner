import { describe, expect, it } from 'vitest';
import {
  BaselineSecretScanner,
  maskPreview,
  PublishError,
  scanText,
  shannonEntropy,
} from '../../../../src/main/publish';
import type { PublishFile } from '../../../../src/main/publish';

// Fake secrets are assembled at runtime so the repository never contains a secret-shaped literal.
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC';
const cycle = (alphabet: string, n: number): string =>
  Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('');

const fake = {
  privateKey: ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
  cloudKeyId: 'AK' + 'IA' + cycle(UPPER + '234567', 16),
  anthropicKey: 'sk' + '-ant-' + 'api03-' + cycle(ALNUM, 40),
  projKey: 'sk' + '-proj-' + cycle(ALNUM, 30),
  plainSkKey: 'sk' + '-' + cycle(ALNUM, 48),
  ghp: 'gh' + 'p_' + cycle(ALNUM, 36),
  gho: 'gh' + 'o_' + cycle(ALNUM, 36),
  ghs: 'gh' + 's_' + cycle(ALNUM, 36),
  fineGrained: 'github' + '_pat_' + cycle(ALNUM, 22) + '_' + cycle(ALNUM, 30),
  bearer: 'Authorization: ' + 'Bearer ' + cycle(ALNUM, 32),
  urlCreds: 'https' + '://deploy:' + 'hunter2pass' + '@git.example.com/repo.git',
  generic: 'client_secret = "' + cycle(ALNUM, 28) + '"',
};

function rulesIn(text: string): string[] {
  return scanText('index.html', text).map((f) => f.rule);
}

describe('BaselineSecretScanner rules (10 §5.4)', () => {
  it('private-key-block', () => {
    expect(fake.privateKey).toContain('PRIVATE KEY');
    expect(rulesIn(`<pre>${fake.privateKey}\nMIIE...\n</pre>`)).toEqual(['private-key-block']);
  });

  it('cloud-access-key-id', () => {
    expect(rulesIn(`key id: ${fake.cloudKeyId} in config`)).toEqual(['cloud-access-key-id']);
  });

  it('llm-api-key (sk-ant-, sk-proj-, sk- + 40)', () => {
    expect(rulesIn(`x ${fake.anthropicKey} y`)).toEqual(['llm-api-key']);
    expect(rulesIn(`x ${fake.projKey} y`)).toEqual(['llm-api-key']);
    expect(rulesIn(`x ${fake.plainSkKey} y`)).toEqual(['llm-api-key']);
  });

  it('code-host-token (ghp_, gho_, ghs_, github_pat_)', () => {
    for (const t of [fake.ghp, fake.gho, fake.ghs, fake.fineGrained]) {
      expect(rulesIn(`token here: ${t}`)).toContain('code-host-token');
    }
  });

  it('bearer-header', () => {
    expect(rulesIn(`curl -H "${fake.bearer}" https://api.example.com`)).toEqual(['bearer-header']);
  });

  it('url-credentials', () => {
    expect(rulesIn(`git clone ${fake.urlCreds}`)).toEqual(['url-credentials']);
  });

  it('generic-high-entropy', () => {
    expect(rulesIn(fake.generic)).toEqual(['generic-high-entropy']);
  });

  it('generic-high-entropy ignores low-entropy values', () => {
    expect(rulesIn('password = "' + 'a'.repeat(30) + '"')).toEqual([]);
    expect(rulesIn('token: ' + 'abababababababababababababab')).toEqual([]);
  });

  it('does not double-report a value a specific rule already caught', () => {
    expect(rulesIn(`token = ${fake.ghp}`)).toEqual(['code-host-token']);
  });

  it('reports 1-based line numbers and masked previews only', () => {
    const findings = scanText('index.html', `line one\nline two\nid ${fake.cloudKeyId}`);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.line).toBe(3);
    expect(f.relPath).toBe('index.html');
    expect(f.preview.startsWith(fake.cloudKeyId.slice(0, 4))).toBe(true);
    expect(f.preview.slice(4)).toMatch(/^\*+$/);
    expect(JSON.stringify(findings)).not.toContain(fake.cloudKeyId);
  });

  it('never leaks an unmasked value for any rule', () => {
    for (const secret of Object.values(fake)) {
      const out = JSON.stringify(scanText('a.html', secret));
      expect(out).not.toContain(secret.slice(5));
    }
  });
});

describe('no false positives on ordinary content', () => {
  it('plain prose', () => {
    const prose = [
      'Revenue recognition explains when a company records income.',
      'Think of it like a lemonade stand: you count the money when you hand over the cup.',
      'The password policy requires twelve characters. Tokens expire after an hour.',
      'Ask-the-expert sessions run weekly; see the task list for details.',
      'The API key concept: a key is like a library card for software.',
    ].join('\n');
    expect(scanText('index.html', prose)).toEqual([]);
  });

  it('typical generated HTML', () => {
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Explainer</title>
<style>:root{--accent:#3b82f6}.card{border-radius:8px}</style></head>
<body><h1>How OAuth works</h1>
<p>The app sends an <code>Authorization</code> header with a bearer token. See
<a href="https://example.com/docs/oauth?step=2#tokens">the docs</a> or mailto:help@example.com.</p>
<pre><code>const token = getToken();
fetch(url, { headers: { Authorization: \`Bearer \${token}\` } });</code></pre>
<img alt="diagram" src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">
<script>document.querySelectorAll('.card').forEach(c => c.classList.add('ready'));</script>
</body></html>`;
    expect(scanText('index.html', html)).toEqual([]);
  });
});

describe('BaselineSecretScanner.scan', () => {
  const file = (relPath: string): PublishFile => ({ relPath, absPath: `/docs/demo/${relPath}`, bytes: 0, sha256: '' });
  const enc = (s: string) => new TextEncoder().encode(s);

  it('reads each file and aggregates findings', async () => {
    const contents: Record<string, Uint8Array> = {
      '/docs/demo/index.html': enc(`<p>${fake.ghp}</p>`),
      '/docs/demo/assets/app.js': enc(`const k = "${fake.cloudKeyId}";`),
    };
    const s = new BaselineSecretScanner({ readFile: (p) => Promise.resolve(contents[p] ?? new Uint8Array()) });
    const out = await s.scan([file('index.html'), file('assets/app.js')], new AbortController().signal);
    expect(out.map((f) => [f.relPath, f.rule])).toEqual([
      ['index.html', 'code-host-token'],
      ['assets/app.js', 'cloud-access-key-id'],
    ]);
  });

  it('skips binary files by extension and by NUL byte', async () => {
    const reads: string[] = [];
    const s = new BaselineSecretScanner({
      readFile: (p) => {
        reads.push(p);
        return Promise.resolve(new Uint8Array([...enc(fake.ghp), 0, 1, 2]));
      },
    });
    const out = await s.scan(
      [file('assets/a.png'), file('assets/f.woff2'), file('assets/blob.css')],
      new AbortController().signal,
    );
    expect(out).toEqual([]);
    expect(reads).toEqual(['/docs/demo/assets/blob.css']);
  });

  it('throws E_PUBLISH_CANCELLED when the signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const s = new BaselineSecretScanner({ readFile: () => Promise.resolve(enc('')) });
    const err = await s.scan([file('index.html')], ac.signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).code).toBe('E_PUBLISH_CANCELLED');
  });
});

describe('helpers', () => {
  it('shannonEntropy', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy(cycle(ALNUM, 24))).toBeGreaterThan(4);
  });

  it('maskPreview keeps 4 chars and caps the mask', () => {
    expect(maskPreview('abcdefgh')).toBe('abcd****');
    expect(maskPreview('abc')).toBe('abc');
    expect(maskPreview('x'.repeat(100))).toBe('xxxx' + '*'.repeat(16));
  });
});
