import { z } from 'zod';

/**
 * The only place settings keys are declared (12 §3). Types, defaults and validation derive from it.
 * Zod 4 note: `.prefault({})` (not `.default({})`) so nested defaults are applied.
 */

/** Closed set. The enterprise backend registers under 'bedrock' (HOOK-LLM-01). */
export const ProviderIdSchema = z.enum(['claude', 'openai', 'bedrock']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Dormant namespaces: accepted, preserved, inert in the public build (12 §3.3). */
const Dormant = z.record(z.string(), z.unknown()).prefault({});

export const SettingsSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    llm: z
      .object({
        provider: ProviderIdSchema.default('claude'),
        model: z.string().trim().min(1).max(200).nullable().default(null), // null = provider default (02)
        maxOutputTokens: z.number().int().min(1024).max(128000).default(32000),
        timeoutMs: z.number().int().min(10_000).max(1_800_000).default(1_800_000),
        maxConcurrency: z.number().int().min(1).max(6).default(2),
        bedrock: Dormant, // HOOK-LLM-01
      })
      .strict()
      .prefault({}),
    glossary: z
      .object({
        defaultOn: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    sources: z
      .object({
        mcp: z
          .object({
            url: z
              .string()
              .url()
              .refine((u) => u.startsWith('https://'), 'https only')
              .nullable()
              .default(null),
          })
          .passthrough()
          .prefault({}), // HOOK-SRC-01, HOOK-AUTH-01
      })
      .strict()
      .prefault({}),
    fetch: z
      .object({
        network: Dormant, // HOOK-FETCH-01 (05)
      })
      .passthrough()
      .prefault({}),
    pipeline: z
      .object({
        maxConcurrentJobs: z.number().int().min(1).max(3).default(1), // 06 §4.1
      })
      .strict()
      .prefault({}),
    publish: z
      .object({
        local: z
          .object({
            dir: z.string().default('~/Documents/ELI5 Learner'), // 10 §5.1
            revealAfter: z.boolean().default(true),
          })
          .strict()
          .prefault({}),
        drive: Dormant, // HOOK-PUB-01, HOOK-PUB-02
        github: Dormant, // HOOK-PUB-03, HOOK-PUB-04
      })
      .passthrough()
      .prefault({}),
    logging: z
      .object({
        level: z.enum(['info', 'debug']).default('info'),
      })
      .strict()
      .prefault({}),
    enterprise: Dormant, // reserved for SettingsExtension (HOOK-CFG-01)
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object | null ? DeepPartial<T[K]> : T[K];
};

export const CURRENT_SCHEMA_VERSION = 1;
export const DEFAULTS: Settings = SettingsSchema.parse({});

export const DORMANT_NAMESPACES = [
  'llm.bedrock',
  'sources.mcp',
  'fetch.network',
  'publish.drive',
  'publish.github',
  'enterprise',
] as const;
export type DormantNamespace = (typeof DORMANT_NAMESPACES)[number];

/** True when a dotted path is inside a dormant namespace (sources.mcp.url keeps its own check). */
export function isDormantPath(path: string): boolean {
  return DORMANT_NAMESPACES.some((ns) => path === ns || path.startsWith(`${ns}.`));
}

/** Default model per provider when llm.model is null (02). Pinned per release. */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  claude: 'claude-opus-5', // GA model; claude-opus-5-5 is still launching (02 §5)
  openai: 'gpt-5',
  bedrock: '',
};

export function effectiveModel(s: Settings): string {
  return s.llm.model ?? DEFAULT_MODELS[s.llm.provider];
}
