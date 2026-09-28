import { describe, expect, it } from 'vitest';
import {
  classifyLogin,
  domSignals,
  httpSignals,
  isLoginHop,
  urlSignals,
  type DomLoginFacts,
} from '../../../../src/main/fetch/login-wall';
import type { PageSignals } from '../../../../src/main/fetch/types';

const signals: PageSignals = {
  bodyTextLength: 300,
  articleTextLength: 0,
  readerable: false,
  scriptBytes: 0,
  htmlBytes: 1000,
  mountPointEmpty: false,
  noscriptSaysEnableJs: false,
  hasPasswordField: false,
  formCount: 0,
  metaRefreshUrl: null,
  titleText: '',
  challengeMarkers: false,
};
const facts = (o: Partial<PageSignals> = {}, f: Partial<DomLoginFacts> = {}): DomLoginFacts => ({
  signals: { ...signals, ...o },
  loginHeading: false,
  paywallMarkers: false,
  selectorHits: [],
  ...f,
});

describe('login-wall signals (05 §7.1)', () => {
  it('HTTP: 401, WWW-Authenticate and 407 are conclusive', () => {
    expect(httpSignals(401, {})).toEqual([{ weight: 'conclusive', source: 'http' }]);
    expect(httpSignals(403, { 'www-authenticate': 'Bearer' })[0]?.weight).toBe('conclusive');
    expect(httpSignals(407, {})).toEqual([{ weight: 'conclusive', source: 'http', proxy: true }]);
    expect(httpSignals(200, {})).toEqual([]);
  });

  it.each([
    'https://site.example/login',
    'https://site.example/users/sign-in/',
    'https://site.example/sso?x=1',
    'https://site.example/saml2/acs',
    'https://site.example/oauth2/authorize',
    'https://site.example/account/login',
    'https://site.example/session/new',
    'https://site.example/start?returnUrl=%2F',
    'https://site.example/start?RelayState=abc',
    'https://site.example/start?SAMLRequest=abc',
  ])('URL pattern: %s is strong', (u) => {
    expect(urlSignals(u, 'https://site.example/doc', [])).toEqual([{ weight: 'strong', source: 'url' }]);
  });

  it('URL: a different host whose first label is an identity label is strong', () => {
    expect(urlSignals('https://accounts.example.test/x', 'https://docs.example.test/a', [])).toHaveLength(1);
    expect(urlSignals('https://docs.example.test/x', 'https://docs.example.test/a', [])).toHaveLength(0);
    expect(urlSignals('https://site.example/blog/logins-explained', 'https://site.example/', [])).toHaveLength(0);
  });

  it('signatures (HOOK-FETCH-02): host/url patterns on URLs, dom selectors only with DOM facts', () => {
    const sigs = [
      { hostPattern: /^idp\.example\.test$/, kind: 'conclusive' as const },
      { domSelector: '#corp-login', kind: 'strong' as const },
    ];
    expect(urlSignals('https://idp.example.test/', 'https://idp.example.test/', sigs)).toContainEqual({
      weight: 'conclusive',
      source: 'signature',
    });
    expect(urlSignals('https://w.example/', 'https://w.example/', sigs)).toEqual([]);
    expect(urlSignals('https://w.example/', 'https://w.example/', sigs, ['#corp-login'])).toEqual([
      { weight: 'strong', source: 'signature' },
    ]);
    expect(isLoginHop('https://idp.example.test/', 'https://w.example/', sigs)).toBe(true);
    expect(isLoginHop('https://w.example/next', 'https://w.example/', sigs)).toBe(false);
  });

  it('DOM: password field with little article, sign-in heading with a form, 403 amplifier, paywall', () => {
    expect(domSignals(facts({ hasPasswordField: true }))).toHaveLength(1);
    expect(domSignals(facts({ hasPasswordField: true, articleTextLength: 1500 }))).toHaveLength(0);
    expect(domSignals(facts({ formCount: 1 }, { loginHeading: true }))).toHaveLength(1);
    expect(domSignals(facts({ formCount: 0 }, { loginHeading: true }))).toHaveLength(0);
    expect(domSignals(facts({ hasPasswordField: true }), 403)).toHaveLength(2);
    expect(domSignals(facts({}, { paywallMarkers: true }))).toEqual([{ weight: 'paywall', source: 'dom' }]);
  });
});

describe('classifyLogin (05 §7.2)', () => {
  it('conclusive → login-required (proxy flag kept)', () => {
    expect(classifyLogin([{ weight: 'conclusive', source: 'http', proxy: true }], 5000)).toEqual({
      verdict: 'login-required',
      proxy: true,
    });
  });
  it('two strong → login-required; one strong → decide after render', () => {
    const strong = { weight: 'strong' as const, source: 'dom' as const };
    expect(classifyLogin([strong, strong], 0).verdict).toBe('login-required');
    expect(classifyLogin([strong], 0).verdict).toBe('one-strong');
  });
  it('paywall under 1500 chars → paywall; above → keep the partial article', () => {
    const pw = { weight: 'paywall' as const, source: 'dom' as const };
    expect(classifyLogin([pw], 400).verdict).toBe('paywall');
    expect(classifyLogin([pw], 1500).verdict).toBe('none');
  });
  it('nothing → none', () => {
    expect(classifyLogin([], 0).verdict).toBe('none');
  });
});
