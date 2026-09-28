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
  it('trims and warns on unexpected prefixes', () => {
    expect(checkApiKeyFormat('claude', '  sk-ant-test  ')).toEqual({ ok: true, key: 'sk-ant-test' });
    const r = checkApiKeyFormat('openai', 'key-test');
    expect(r.ok && r.warning).toBeTruthy();
  });
});
