/** Fixture enterprise LLM backend: the public FakeProvider registered as `bedrock` (13 §10.1). */
import type { FakeScript } from '@eli5/public/llm/testing/fake';
import { FakeProvider } from '@eli5/public/llm/testing/fake';
import defaultScript from '../llm/default.json';

export const FIXTURE_GATEWAY_MODEL = 'fixture-gateway-model';

/** Default script (13 §6.1) produces a complete, valid document for any input. */
const DEFAULT_SCRIPT: FakeScript = defaultScript;

export function createFixtureGateway(script: FakeScript = DEFAULT_SCRIPT): FakeProvider {
  return new FakeProvider(script, { id: 'bedrock', model: FIXTURE_GATEWAY_MODEL });
}
