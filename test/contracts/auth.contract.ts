/**
 * AuthCapability contract suite (13 §10.2; the seam is `AuthBroker`, 03 §12, HOOK-AUTH-01).
 * status() is synchronous and never triggers interaction; sign-in and sign-out either return an
 * AuthStatus or, when the broker reports `unavailable`, throw NotAvailableInEdition; no token-shaped
 * value ever crosses the interface (statuses, results, change events).
 */
import { describe, expect, it } from 'vitest';
import { NotAvailableInEdition } from '../../src/main/editions';
import type { AuthBroker, AuthState, AuthStatus } from '../../src/main/sources';
import { findCredentialLike } from './source-resolver.contract';

const STATES: readonly AuthState[] = ['unavailable', 'signed-out', 'signing-in', 'signed-in', 'expired', 'error'];
const STATUS_KEYS = new Set(['state', 'account', 'detail', 'updatedAt']);

function expectStatus(s: AuthStatus): void {
  expect(STATES).toContain(s.state);
  expect(new Date(s.updatedAt).toISOString()).toBe(s.updatedAt);
  for (const k of Object.keys(s)) expect(STATUS_KEYS.has(k), `unexpected AuthStatus key "${k}"`).toBe(true);
  if (s.account !== undefined) expect(typeof s.account).toBe('string');
  expect(findCredentialLike(JSON.stringify(s))).toBeNull();
}

/** Runs sign-in/out whether the broker throws synchronously (public stub) or rejects. */
function attempt(fn: () => Promise<AuthStatus>): Promise<AuthStatus | Error> {
  return Promise.resolve()
    .then(fn)
    .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
}

export interface AuthContractOptions<B extends AuthBroker> {
  /** Counts interactive prompts (browser, dialog) the broker has opened, when it can observe them. */
  interactions?: (b: B) => number;
}

export function describeAuthContract<B extends AuthBroker>(
  name: string,
  make: () => Promise<B>,
  opts: AuthContractOptions<B> = {},
): void {
  describe(`AuthCapability contract: ${name}`, () => {
    it('status() is synchronous, well formed and carries no token', async () => {
      const b = await make();
      const s = b.status();
      expect(s).not.toBeInstanceOf(Promise);
      expectStatus(s);
    });

    it('status() never triggers interaction or state changes', async () => {
      const b = await make();
      const events: AuthStatus[] = [];
      const off = b.onChange((s) => events.push(s));
      const prompts = opts.interactions?.(b);
      const first = b.status();
      for (let i = 0; i < 5; i++) expect(b.status().state).toBe(first.state);
      await new Promise((r) => setTimeout(r, 10));
      expect(events).toEqual([]);
      expect(first.state).not.toBe('signing-in');
      if (opts.interactions) expect(opts.interactions(b), 'status() opened an interactive prompt').toBe(prompts);
      off();
    });

    it('sign-in and sign-out return AuthStatus, or NotAvailableInEdition when unavailable', async () => {
      const b = await make();
      const unavailable = b.status().state === 'unavailable';
      const events: AuthStatus[] = [];
      const off = b.onChange((s) => events.push(s));
      const inRes = await attempt(() => b.signIn());
      const outRes = await attempt(() => b.signOut());
      off();
      for (const r of [inRes, outRes]) {
        if (unavailable) {
          expect(r).toBeInstanceOf(NotAvailableInEdition);
          expect((r as NotAvailableInEdition).hookId).toBe('HOOK-AUTH-01');
        } else {
          expect(r).not.toBeInstanceOf(Error);
          expectStatus(r as AuthStatus);
        }
      }
      if (unavailable) {
        expect(events).toEqual([]);
      } else {
        expect(['signed-in', 'error']).toContain((inRes as AuthStatus).state);
        expect((outRes as AuthStatus).state).toBe('signed-out');
        expect(b.status().state).toBe('signed-out');
        for (const e of events) expectStatus(e);
      }
    });

    it('onChange returns an unsubscribe that stops delivery', async () => {
      const b = await make();
      const events: AuthStatus[] = [];
      const off = b.onChange((s) => events.push(s));
      expect(typeof off).toBe('function');
      off();
      await attempt(() => b.signIn());
      await attempt(() => b.signOut());
      expect(events).toEqual([]);
    });
  });
}
