/**
 * Fixture overlay (13 §10.1 cell F). Exercises the overlay mechanism only: it contains no
 * organization details and registers fakes through the public registry slots.
 */
import type { CapabilityRegistry, EditionOverlay } from '@eli5/public/editions';
import { OVERLAY_API_VERSION } from '@eli5/public/editions';
import type { LLMProvider } from '@eli5/public/llm';
import { LLMError, fallbackLimits } from '@eli5/public/llm';
import type { Publisher } from '@eli5/public/publish';

const fakeGateway: LLMProvider = {
  id: 'bedrock',
  model: 'fixture-gateway-model',
  limits: fallbackLimits('bedrock'),
  generate: () => Promise.reject(new LLMError('bad_request', 'fixture overlay provider has no scripted responses')),
  generateWithImages: () =>
    Promise.reject(new LLMError('bad_request', 'fixture overlay provider has no scripted responses')),
  testConnection: async () => ({ ok: true, model: 'fixture-gateway-model' }),
};

function recordingPublisher(reg: CapabilityRegistry, id: 'drive' | 'git'): Publisher {
  const local = reg.publisher('local');
  return {
    id,
    kind: id,
    describe: async (slug, settings) => ({
      ...(await local.describe(slug, settings)),
      id,
      kind: id,
      requiresSignIn: false,
    }),
    publish: (ctx) => local.publish(ctx),
  };
}

const overlay: EditionOverlay = {
  apiVersion: OVERLAY_API_VERSION,
  name: 'Fixture overlay',
  register(reg) {
    reg.registerLLMProvider('bedrock', () => fakeGateway);
    reg.registerPublisher('drive', () => recordingPublisher(reg, 'drive'));
    reg.registerPublisher('git', () => recordingPublisher(reg, 'git'));
    reg.enableUiFeatures(['publish.drive', 'publish.git']);
  },
};

export default overlay;
