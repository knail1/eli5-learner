/** Public registrations for the sources module (01 §6.3 step 2; priorities per 01 §6.2). */
import type { CapabilityRegistry } from '../editions';
import { PublicAuthBroker } from './auth';
import { ClipboardResolver } from './clipboard';
import { FileResolver } from './file';
import { buildLaneRouter } from './lanes';
import { McpResolverStub } from './mcp.stub';
import { defaultStagingPolicy } from './staging';
import { TicketResolverStub } from './ticket.stub';
import { UrlResolver } from './url';

export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerAuth(new PublicAuthBroker(reg.edition)); // HOOK-AUTH-01
  reg.registerSourceResolver(new TicketResolverStub(), { priority: 40 }); // HOOK-SRC-02
  reg.registerSourceResolver(new McpResolverStub(), { priority: 30 }); // HOOK-SRC-01
  reg.registerSourceResolver(new UrlResolver(), { priority: 20 });
  reg.registerSourceResolver(new FileResolver(), { priority: 10 });
  reg.registerSourceResolver(new ClipboardResolver(), { priority: 10 });
  reg.setLaneRouterFactory(buildLaneRouter); // HOOK-SRC-03
  reg.registerLaneRules([]); // HOOK-SRC-03: empty in public
  reg.registerStagingPolicy(defaultStagingPolicy); // HOOK-SRC-04
}
