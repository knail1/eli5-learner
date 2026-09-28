/** MCP-brokered resolver stub (03 §10, HOOK-SRC-01). Registered but never selected in public. */
import { NotAvailableInEdition } from '../editions';
import type { ResolveContext, ResolveOutcome, SourceInput, SourceResolver } from './types';

export class McpResolverStub implements SourceResolver {
  readonly stub = true;
  readonly id = 'mcp';
  readonly handles = ['url'] as const;
  readonly lane = 'mcp' as const;

  /** Never claims in public; no lane rule routes here (03 §8, HOOK-SRC-03). */
  canResolve(_input: SourceInput, _ctx: ResolveContext): boolean {
    return false;
  }

  resolve(_input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome> {
    return Promise.reject(new NotAvailableInEdition('source:mcp', 'HOOK-SRC-01', ctx.edition));
  }
}

export const mcpResolverStub: SourceResolver = new McpResolverStub();
