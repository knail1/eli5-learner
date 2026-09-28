import { describe, expect, it } from 'vitest';
import { Registry } from '../../../../src/main/editions/registry';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { defaultPipelinePolicy, registerPublic } from '../../../../src/main/pipeline';

describe('pipeline registerPublic (HOOK-PIPE-01)', () => {
  it('registers defaultPipelinePolicy', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    expect(reg.pipelinePolicy()).toBe(defaultPipelinePolicy);
    expect(reg.missingSlots()).not.toContain('pipelinePolicy');
  });

  it('public defaults match 06', () => {
    const p = defaultPipelinePolicy;
    expect(p.maxCreateSlots).toBe(3);
    expect(p.snapshotCopyMaxBytes).toBe(200 * 1024 * 1024);
    expect(p.retention).toEqual({ failedStagingDays: 7, recordDays: 30 });
    expect(p.llmRetryOverride).toBeUndefined();
    expect(p.llmTimeoutOverride).toBeUndefined();
  });

  it('an overlay policy replaces the default', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    const custom = { ...defaultPipelinePolicy, maxCreateSlots: 2 };
    reg.registerPipelinePolicy(custom);
    expect(reg.pipelinePolicy().maxCreateSlots).toBe(2);
  });
});
