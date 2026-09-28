import { describe, expect, it } from 'vitest';
import { isPrivateHostName, isPrivateIp, isPrivateTarget, logUrl, validateUrl } from '../../../../src/main/fetch/url';

describe('validateUrl (05 §4.1)', () => {
  it('accepts http/https, lowercases and IDNA-encodes the host, strips the fragment and trailing dot', () => {
    const v = validateUrl('https://BÜCHER.Example./Path?q=1#frag');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.href).toBe('https://xn--bcher-kva.example/Path?q=1');
  });

  it.each([
    ['not a url', 'invalid-url'],
    ['', 'invalid-url'],
    ['ftp://files.example/x', 'blocked-scheme'],
    ['data:text/html,hi', 'blocked-scheme'],
    ['javascript:void(0)', 'blocked-scheme'],
    ['blob:https://x.example/uuid', 'blocked-scheme'],
    ['file:///etc/hosts', 'blocked-scheme'],
  ])('%s → %s', (raw, code) => {
    const v = validateUrl(raw);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });

  it('rejects userinfo (built at runtime)', () => {
    const u = ['a', 'b'].join('');
    const v = validateUrl(`https://${u}:${u}@site.example/`);
    expect(v.ok ? null : v.code).toBe('credentials-in-url');
    const v2 = validateUrl(`https://${u}@site.example/`);
    expect(v2.ok ? null : v2.code).toBe('credentials-in-url');
  });

  it('resolves relative redirect targets against a base', () => {
    const v = validateUrl('../b?x=1', 'https://site.example/a/c');
    expect(v.ok && v.href).toBe('https://site.example/b?x=1');
  });
});

describe('private-address guard (05 §4.4 rule 4)', () => {
  it.each([
    'localhost',
    'dev.localhost',
    'printer.local',
    'db.corp.internal',
    '127.0.0.1',
    '10.0.0.8',
    '172.16.4.4',
    '172.31.255.1',
    '192.168.1.20',
    '169.254.1.1',
    '0.0.0.0',
    '::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:10.0.0.1',
  ])('%s is private', (h) => expect(isPrivateHostName(h)).toBe(true));

  it.each(['example.com', '203.0.113.10', '172.32.0.1', '8.8.8.8', '2001:db8::1', 'localhost.example.com'])(
    '%s is not private by name',
    (h) => expect(isPrivateHostName(h)).toBe(false),
  );

  it('uses DNS for names, caches per host, and treats lookup failures as not private', async () => {
    let calls = 0;
    const lookup = async (h: string) => {
      calls += 1;
      if (h === 'broken.example') throw new Error('ENOTFOUND');
      return h === 'lan.example' ? ['192.168.0.9'] : ['203.0.113.7'];
    };
    const cache = new Map<string, boolean>();
    expect(await isPrivateTarget('https://lan.example/x', lookup, cache)).toBe(true);
    expect(await isPrivateTarget('https://lan.example/y', lookup, cache)).toBe(true);
    expect(calls).toBe(1);
    expect(await isPrivateTarget('https://site.example/', lookup, cache)).toBe(false);
    expect(await isPrivateTarget('https://broken.example/', lookup, cache)).toBe(false);
    expect(await isPrivateTarget('http://[::1]:8080/', lookup, cache)).toBe(true);
    expect(isPrivateIp('not-an-ip')).toBe(false);
  });
});

describe('logUrl (05 §10)', () => {
  it('drops query strings and fragments', () => {
    expect(logUrl('https://site.example/a/b?token=abc#x')).toBe('https://site.example/a/b');
    expect(logUrl('%%%')).toBe('url:invalid');
  });
});
