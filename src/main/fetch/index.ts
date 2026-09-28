/** URL fetching (05): fetchUrl() for the public web lane. */
import { createFetcher, type Fetcher } from './fetcher';
import { configureSession } from './network';
import type {
  BytesOutcome,
  BytesRequest,
  FetchContext,
  FetchOutcome,
  LoginSignature,
  NetworkConfigurator,
} from './types';

export type {
  BytesOutcome,
  BytesRequest,
  FetchContext,
  FetchedArticle,
  FetchedBinary,
  FetchOutcome,
  FetchProgress,
  FetchSkipCode,
  LoginSignature,
  NetworkConfigurator,
  PageSignals,
} from './types';
export { configureSession } from './network';
export { registerPublic } from './register';
export { createFetcher } from './fetcher';
export type { Fetcher, FetcherDeps } from './fetcher';
export { reasonFor } from './errors';
export { nodeTransport } from './node-transport';
export type { HttpTransport, TransportRequest, TransportResponse, RedirectHop } from './transport';
export { inProcessReadability, ReadabilityPool } from './readability';
export type { ReadabilityRunner } from './readability';
export { RenderPool, renderInHiddenWindow } from './render-window';
export type { RenderBackend, RenderWindow, RenderResult, RenderOptions } from './render-window';
export { LIMITS } from './constants';

interface FetchSetup {
  configureSession: NetworkConfigurator;
  loginSignatures: readonly LoginSignature[];
}

let setup: FetchSetup = { configureSession, loginSignatures: [] };
let active: Promise<Fetcher> | null = null;

/**
 * Bootstrap hook: pass the frozen registry's networkConfigurator() and loginSignatures()
 * (HOOK-FETCH-01/02). Must run before the first fetchUrl call.
 */
export function configureFetch(s: FetchSetup): void {
  setup = s;
  active = null;
}

/** Replaces the process-wide fetcher (tests, or a custom wiring). `null` restores the default. */
export function setFetcher(f: Fetcher | null): void {
  active = f ? Promise.resolve(f) : null;
}

function current(): Promise<Fetcher> {
  if (!active) {
    const s = setup;
    active = import('./electron').then(async (m) => createFetcher(await m.createElectronFetchDeps(s)));
    active.catch(() => (active = null));
  }
  return active;
}

/** 05 §2: never throws except AbortError on ctx.signal (and programmer errors). */
export async function fetchUrl(url: string, ctx: FetchContext): Promise<FetchOutcome> {
  return (await current()).fetchUrl(url, ctx);
}

/**
 * 05 §4.8: small in-memory GET for app-initiated downloads (stock photo search and images, 07 §7.4)
 * through the fetch session, politeness and private-address guard. Never throws except AbortError.
 */
export async function fetchBytes(url: string, o: BytesRequest): Promise<BytesOutcome> {
  return (await current()).fetchBytes(url, o);
}

/** Pipeline calls this when a job ends: drops the per-job dedupe cache and clears fetch cookies (05 §3, §4.2). */
export async function endFetchJob(jobId: string): Promise<void> {
  if (active) await (await active).endJob(jobId);
}
