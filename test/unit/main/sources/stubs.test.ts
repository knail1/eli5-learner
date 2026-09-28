import { describe, expect, it } from 'vitest';
import { NotAvailableInEdition } from '../../../../src/main/editions/errors';
import { PublicAuthBroker } from '../../../../src/main/sources/auth';
import { McpResolverStub } from '../../../../src/main/sources/mcp.stub';
import { TicketResolverStub } from '../../../../src/main/sources/ticket.stub';
import type { SourceInput } from '../../../../src/main/sources/types';
import { fakeCtx } from './helpers';

const urlInput: SourceInput = { id: 'in-0000abcd', kind: 'url', origin: 'url-field', url: 'https://example.com/' };

describe.each([
  { Cls: McpResolverStub, id: 'mcp', capability: 'source:mcp', hookId: 'HOOK-SRC-01' },
  { Cls: TicketResolverStub, id: 'ticket', capability: 'source:ticket', hookId: 'HOOK-SRC-02' },
])('$id resolver stub', ({ Cls, id, capability, hookId }) => {
  const stub = new Cls();

  it('has the spec shape and is marked as a stub', () => {
    expect(stub.id).toBe(id);
    expect(stub.handles).toEqual(['url']);
    expect(stub.lane).toBe('mcp');
    expect(stub.stub).toBe(true);
  });

  it('never claims an input in public', () => {
    expect(stub.canResolve(urlInput, fakeCtx())).toBe(false);
  });

  it(`rejects with NotAvailableInEdition(${capability}, ${hookId})`, async () => {
    const err = await stub.resolve(urlInput, fakeCtx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotAvailableInEdition);
    expect(err).toMatchObject({ capability, hookId, edition: 'public', code: 'E_NOT_AVAILABLE_IN_EDITION' });
  });
});

describe('PublicAuthBroker', () => {
  const b = new PublicAuthBroker('public');

  it('reports unavailable with an ISO timestamp', () => {
    const s = b.status();
    expect(s.state).toBe('unavailable');
    expect(s.account).toBeUndefined();
    expect(new Date(s.updatedAt).toISOString()).toBe(s.updatedAt);
    expect(b.stub).toBe(true);
  });

  it.each(['signIn', 'signOut'] as const)('%s throws NotAvailableInEdition(auth, HOOK-AUTH-01)', (m) => {
    let err: unknown;
    try {
      void b[m]();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotAvailableInEdition);
    expect(err).toMatchObject({ capability: 'auth', hookId: 'HOOK-AUTH-01', edition: 'public' });
  });

  it('onChange returns an unsubscribe and never fires', () => {
    let fired = 0;
    const off = b.onChange(() => fired++);
    off();
    expect(fired).toBe(0);
  });
});
