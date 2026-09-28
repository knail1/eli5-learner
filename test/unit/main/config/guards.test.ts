import { describe, expect, it } from 'vitest';
import { checkApiKeyFormat, findSecrets, redact } from '../../../../src/main/config';

// Secret-shaped strings are assembled at runtime so the repo never contains literal ones.
const shapes = {
  anthropic: ['sk', 'ant', 'a'.repeat(24)].join('-'),
  codeHost: 'gh' + 'p_' + 'B'.repeat(36),
  pat: 'github' + '_pat_' + 'C'.repeat(20),
  cloud: 'AK' + 'IA' + 'D'.repeat(16),
  chat: 'xo' + 'xb-' + '123-abc',
  jwt: ['eyJ' + 'hbGci', 'eyJ' + 'zdWIi', 'sig'].join('.'),
  pem: '-----BEGIN ' + 'PRIVATE KEY-----',
  entropy: 'q8Z3vN1xT7mK2pL9sR4wY6cB0dF5gH3j',
};

describe('findSecrets (12 §5.4)', () => {
  it.each(Object.entries(shapes))('flags %s values by shape', (_name, value) => {
    expect(findSecrets({ a: { b: value } })).toEqual(['a.b']);
  });
  it('flags secret-looking key names with a value', () => {
    expect(findSecrets({ publish: { github: { token: 'abc' } } })).toEqual(['publish.github.token']);
    expect(findSecrets({ publish: { github: { token: '' } } })).toEqual([]);
  });
  it('ignores ordinary settings', () => {
    expect(
      findSecrets({
        llm: { provider: 'claude', model: 'claude-opus-5-5' },
        publish: { local: { dir: '~/Documents/ELI5 Learner' } },
      }),
    ).toEqual([]);
  });
});

describe('findSecrets on folder paths (12 §5.4)', () => {
  // A chosen folder is a path, not a token: its whole string can pass 4.5 bits per character
  // (a hashed macOS temp dir, a synced-storage folder), but no single segment looks like a key.
  const tempLike = `/private/var/folders/z9/${'jt4cn2td0gn40p7sh34cbzg8'}0000gn/T/eli5-e2e-m3-publish-Qx7Rk2/exports`;

  it('accepts an absolute or home path whose segments are ordinary', () => {
    expect(findSecrets({ publish: { local: { dir: tempLike } } })).toEqual([]);
    expect(findSecrets({ publish: { local: { dir: '~/Library/CloudStorage/Drive-Qx7Rk2/Exports/2026' } } })).toEqual(
      [],
    );
  });

  it('still flags a path that carries a high-entropy segment or a known shape', () => {
    expect(findSecrets({ publish: { local: { dir: `/Users/x/${shapes.entropy}` } } })).toEqual(['publish.local.dir']);
    expect(findSecrets({ publish: { local: { dir: `/${shapes.anthropic}` } } })).toEqual(['publish.local.dir']);
  });

  it('keeps the whole-string entropy rule for values that are not paths', () => {
    expect(findSecrets({ a: tempLike.replaceAll('/', '') })).toEqual(['a']);
  });
});

describe('redact', () => {
  it('replaces credential shapes inside text', () => {
    const out = redact(`key=${shapes.anthropic} and ${shapes.codeHost}`);
    expect(out).not.toContain(shapes.anthropic);
    expect(out).not.toContain(shapes.codeHost);
    expect(out).toContain('[REDACTED]');
  });
  it('keeps ordinary text', () => {
    expect(redact('job done in 42 ms')).toBe('job done in 42 ms');
  });
});

describe('checkApiKeyFormat (12 §5.2)', () => {
  it('rejects empty, whitespace, control and overlong keys', () => {
    expect(checkApiKeyFormat('claude', '   ').ok).toBe(false);
    expect(checkApiKeyFormat('claude', 'sk-ant-a b').ok).toBe(false);
    expect(checkApiKeyFormat('claude', 'sk-ant-\u0001').ok).toBe(false);
    expect(checkApiKeyFormat('claude', 'x'.repeat(513)).ok).toBe(false);
  });
  it('strips one pair of surrounding quotes pasted from a .env file or docs', () => {
    expect(checkApiKeyFormat('claude', '"sk-ant-test"')).toEqual({ ok: true, key: 'sk-ant-test' });
    expect(checkApiKeyFormat('claude', " 'sk-ant-test' ")).toEqual({ ok: true, key: 'sk-ant-test' });
    expect(checkApiKeyFormat('claude', '"sk-ant-test').ok).toBe(true); // unbalanced: kept, then warned
    expect(checkApiKeyFormat('claude', '""').ok).toBe(false);
  });
  it('trims and warns on unexpected prefixes', () => {
    expect(checkApiKeyFormat('claude', '  sk-ant-test  ')).toEqual({ ok: true, key: 'sk-ant-test' });
    const r = checkApiKeyFormat('openai', 'key-test');
    expect(r.ok && r.warning).toBeTruthy();
  });
});
