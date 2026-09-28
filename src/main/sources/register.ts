/**
 * Public registrations for the sources module (01 §6.3 step 2). The real file / clipboard / url
 * resolvers arrive in M1 and register here with their default priorities (01 §6.2).
 */
import type { CapabilityRegistry } from '../editions';
import { PublicAuthBroker } from './auth';
import { buildLaneRouter } from './lanes';
import { McpResolverStub } from './mcp.stub';
import { defaultStagingPolicy } from './staging';
import { TicketResolverStub } from './ticket.stub';

export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerAuth(new PublicAuthBroker(reg.edition)); // HOOK-AUTH-01
  reg.registerSourceResolver(new TicketResolverStub()); // HOOK-SRC-02, priority 40
  reg.registerSourceResolver(new McpResolverStub()); // HOOK-SRC-01, priority 30
  reg.setLaneRouterFactory(buildLaneRouter); // HOOK-SRC-03
  reg.registerLaneRules([]); // HOOK-SRC-03: empty in public
  reg.registerStagingPolicy(defaultStagingPolicy); // HOOK-SRC-04
}
