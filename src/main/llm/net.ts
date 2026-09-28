import type { Session } from 'electron';

/**
 * llmFetch (02 §7.4): Electron's Chromium network stack on the `eli5-llm` session, so the system
 * proxy, PAC, Keychain trust and HOOK-FETCH-01 configuration apply to LLM traffic. Bootstrap passes
 * the active network configurator (05 `configureSession` or the overlay's replacement).
 */
export const LLM_SESSION_PARTITION = 'eli5-llm';

export async function createLlmFetch(configure: (ses: Session) => Promise<void>): Promise<typeof fetch> {
  const { session } = await import('electron');
  const ses = session.fromPartition(LLM_SESSION_PARTITION);
  await configure(ses);
  // Electron returns a web Response with a ReadableStream body, which both SDKs stream from.
  return ses.fetch.bind(ses) as unknown as typeof fetch;
}
