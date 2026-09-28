/** Ticket-link resolver stub (03 §11, HOOK-SRC-02). Registered but never selected in public. */
import { NotAvailableInEdition } from '../editions';
import type { ResolveContext, ResolveOutcome, SourceInput, SourceResolver } from './types';

export class TicketResolverStub implements SourceResolver {
  readonly stub = true;
  readonly id = 'ticket';
  readonly handles = ['url'] as const;
  readonly lane = 'mcp' as const;

  /** Never claims in public; only a lane rule with resolverId 'ticket' could select it. */
  canResolve(_input: SourceInput, _ctx: ResolveContext): boolean {
    return false;
  }

  resolve(_input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome> {
    return Promise.reject(new NotAvailableInEdition('source:ticket', 'HOOK-SRC-02', ctx.edition));
  }
}

export const ticketResolverStub: SourceResolver = new TicketResolverStub();
