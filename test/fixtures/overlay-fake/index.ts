/**
 * Fixture overlay (13 §10.1 cell F). Exercises the overlay mechanism only: it contains no
 * organization details and registers fakes through the public registry slots, importing public
 * code only through `@eli5/public/*` (01 §6.5):
 * - FakeProvider as `bedrock` (HOOK-LLM-01)
 * - a fake MCP client, resolver and lane rule serving fixture text (HOOK-SRC-01/03/05)
 * - a fake sign-on capability (HOOK-AUTH-01)
 * - recording `drive` and `git` publishers (HOOK-PUB-01/03)
 * - every UI feature (HOOK-UI-01)
 */
import type { EditionOverlay } from '@eli5/public/editions';
import { OVERLAY_API_VERSION } from '@eli5/public/editions';
import { FixtureAuthBroker } from './auth';
import { createFixtureGateway } from './llm';
import { FIXTURE_LANE_RULES, FixtureMcpClient, FixtureMcpResolver } from './mcp';
import { PublishRecorder, RecordingPublisher } from './publishers';

export { FixtureAuthBroker } from './auth';
export type { FixtureAuthOptions } from './auth';
export { createFixtureGateway, FIXTURE_GATEWAY_MODEL } from './llm';
export { FIXTURE_DOCS_HOST, FIXTURE_LANE_RULES, FixtureMcpClient, FixtureMcpResolver } from './mcp';
export type { FetchDocumentResult } from './mcp';
export { PublishRecorder, RecordingPublisher } from './publishers';
export type { RecordedUpload } from './publishers';

export const FIXTURE_OVERLAY_NAME = 'Fixture overlay';

/** Uploads made by the registered drive and git publishers in this process. */
export const fixtureRecorder = new PublishRecorder();

const overlay: EditionOverlay = {
  apiVersion: OVERLAY_API_VERSION,
  name: FIXTURE_OVERLAY_NAME,
  register(reg) {
    reg.registerLLMProvider('bedrock', () => createFixtureGateway());

    // One shared client serves the resolver and the broker (03 §10.1 rule 1).
    const auth = new FixtureAuthBroker();
    const mcp = new FixtureMcpClient();
    reg.registerAuth(auth);
    reg.registerMcpClient(mcp);
    reg.registerSourceResolver(new FixtureMcpResolver(auth, mcp));
    reg.registerLaneRules(FIXTURE_LANE_RULES);

    // Scanner looked up per publish, so a later HOOK-PUB-03 replacement is honored.
    reg.registerPublisher('drive', () => new RecordingPublisher('drive', fixtureRecorder, () => reg.secretScanner()));
    reg.registerPublisher('git', () => new RecordingPublisher('git', fixtureRecorder, () => reg.secretScanner()));

    reg.enableUiFeatures(['publish.drive', 'publish.git', 'auth.signIn']);
  },
};

export default overlay;
