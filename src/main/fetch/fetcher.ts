import type { Logger } from '../security';
import { LIMITS, type Limits } from './constants';
import { classify } from './detect';
import { abortError, isRetryableNet, reasonFor, type ReasonDetail } from './errors';
import { httpFetch, type HttpResult } from './http';
import { classifyLogin, domSignals, httpSignals, urlSignals, type LoginSignal } from './login-wall';
import { Politeness, sleep as defaultSleep, type PoliteSlot } from './politeness';
import type { ReadabilityResult, ReadabilityRunner } from './readability';
import type { RenderOptions, RenderResult } from './render-window';
import type { HttpTransport } from './transport';
import type { FetchContext, FetchedArticle, FetchOutcome, FetchSkipCode, LoginSignature } from './types';
import { isPrivateTarget, logUrl, systemLookup, validateUrl, type HostLookup } from './url';

/** fetchUrl orchestration, budget, cancellation and per-job dedupe (05 §3). */

export interface FetcherDeps {
  transport: HttpTransport;
  headers: Record<string, string>;
  readability: ReadabilityRunner;
  /** Hidden-window fallback (§8). Absent: pages that need it end as render-failed. */
  render?: (url: string, opts: RenderOptions) => Promise<RenderResult>;
  lookup?: HostLookup;
  loginSignatures?: readonly LoginSignature[]; // HOOK-FETCH-02; [] in the public build
  politeness?: Politeness;
  limits?: Limits;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called by endJob: clears the fetch session's cookies (§4.2). */
  onJobEnd?: (jobId: string) => Promise<void>;
}

export interface Fetcher {
  fetchUrl(url: string, ctx: FetchContext): Promise<FetchOutcome>;
  /** Drops the job's dedupe cache and cookies (called by the pipeline when a job ends). */
  endJob(jobId: string): Promise<void>;
}

const skipped = (code: FetchSkipCode, detail: ReasonDetail = {}, finalUrl?: string): FetchOutcome => ({
  kind: 'skipped',
  code,
  reason: reasonFor(code, detail),
  ...(finalUrl !== undefined ? { finalUrl } : {}),
});

/** Retry-After as delay-seconds or an HTTP-date; null when absent/unparseable. */
export function parseRetryAfter(v: string | undefined, now: number): number | null {
  if (!v) return null;
  if (/^\s*\d+\s*$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

function httpErrorCode(status: number): FetchSkipCode {
  if (status === 404) return 'http-not-found';
  if (status === 410) return 'http-gone';
  if (status === 429) return 'rate-limited';
  return status >= 500 ? 'http-server-error' : 'http-client-error';
}

export function createFetcher(deps: FetcherDeps): Fetcher {
  const L = deps.limits ?? LIMITS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const lookup = deps.lookup ?? systemLookup;
  const sigs = deps.loginSignatures ?? [];
  const politeness = deps.politeness ?? new Politeness();
  const jobs = new Map<string, Map<string, Promise<FetchOutcome>>>();

  async function readability(html: string, url: string, signal: AbortSignal): Promise<ReadabilityResult | null> {
    try {
      return await deps.readability(
        { html, url, selectors: sigs.flatMap((s) => (s.domSelector ? [s.domSelector] : [])) },
        signal,
      );
    } catch (e) {
      if (signal.aborted) throw abortError();
      // Timeout or worker failure: a pathological DOM is often script-built, so try the render lane (§5.2).
      deps.log?.debug('fetch.readability-failed', { errorKind: e instanceof Error ? e.name : 'Error' });
      return null;
    }
  }

  function toArticle(
    res: ReadabilityResult,
    requestedUrl: string,
    finalUrl: string,
    via: 'http' | 'render',
  ): FetchedArticle {
    const a = res.article!;
    return {
      requestedUrl,
      finalUrl,
      title: a.title,
      byline: a.byline,
      siteName: a.siteName,
      lang: a.lang,
      publishedTime: a.publishedTime,
      excerpt: a.excerpt,
      contentHtml: a.contentHtml,
      textLength: a.textLength,
      via,
      imageUrls: a.imageUrls,
    };
  }

  function loginSignals(res: ReadabilityResult, finalUrl: string, requested: string, status: number): LoginSignal[] {
    return [
      ...urlSignals(finalUrl, requested, sigs, res.login.selectorHits),
      ...domSignals({ ...res.login, signals: res.signals }, status),
    ];
  }

  async function run(requested: string, href: string, ctx: FetchContext): Promise<FetchOutcome> {
    const started = now();
    const budget = new AbortController();
    const budgetEnd = started + L.URL_TOTAL_BUDGET_MS;
    const timer = setTimeout(() => budget.abort(), L.URL_TOTAL_BUDGET_MS);
    const onCtx = (): void => budget.abort();
    ctx.signal.addEventListener('abort', onCtx, { once: true });
    const signal = budget.signal;
    let slot: PoliteSlot | null = null;
    let allowPrivate = false;

    const renderFallback = async (
      target: string,
      opts: { carriedStrong: boolean; onFail: FetchOutcome | null },
    ): Promise<FetchOutcome> => {
      const remaining = budgetEnd - now();
      if (remaining < L.RENDER_MIN_BUDGET_MS) return opts.onFail ?? skipped('timeout');
      if (!deps.render) return opts.onFail ?? skipped('render-failed');
      await slot!.beforeRequest(signal); // the render stage counts for host spacing (§9)
      ctx.onProgress?.({ phase: 'render', url: requested });
      const rr = await deps.render(target, {
        signal,
        timeoutMs: Math.min(L.RENDER_TIMEOUT_MS, remaining),
        allowPrivate,
      });
      if (!rr.ok) {
        if (rr.code === 'login-required' || rr.code === 'blocked-private-address') {
          return skipped(rr.code, {}, rr.finalUrl);
        }
        return opts.onFail ?? skipped(rr.code, {}, rr.finalUrl);
      }
      ctx.onProgress?.({ phase: 'extract', url: requested });
      const res = await readability(rr.html, rr.finalUrl, signal);
      if (!res) return opts.onFail ?? skipped('empty-content', {}, rr.finalUrl);
      const lv = classifyLogin(loginSignals(res, rr.finalUrl, href, 200), res.signals.articleTextLength);
      if (lv.verdict === 'login-required') return skipped('login-required', { proxy: lv.proxy }, rr.finalUrl);
      if (lv.verdict === 'paywall') return skipped('paywall', {}, rr.finalUrl);
      const verdict = classify(res.signals);
      if (verdict === 'ok' && res.article)
        return { kind: 'article', content: toArticle(res, requested, rr.finalUrl, 'render') };
      if (res.signals.challengeMarkers) return skipped('render-failed', { challenge: true }, rr.finalUrl);
      if (lv.verdict === 'one-strong' || opts.carriedStrong) return skipped('login-required', {}, rr.finalUrl);
      return opts.onFail ?? skipped('empty-content', {}, rr.finalUrl);
    };

    const handleHtml = async (r: Extract<HttpResult, { kind: 'html' }>): Promise<FetchOutcome> => {
      ctx.onProgress?.({ phase: 'extract', url: requested });
      const res = await readability(r.html, r.finalUrl, signal);
      if (!res) return renderFallback(r.finalUrl, { carriedStrong: false, onFail: skipped('empty-content') });
      const lv = classifyLogin(loginSignals(res, r.finalUrl, href, r.status), res.signals.articleTextLength);
      if (lv.verdict === 'login-required') return skipped('login-required', { proxy: lv.proxy }, r.finalUrl);
      if (lv.verdict === 'paywall') return skipped('paywall', {}, r.finalUrl);
      const verdict = classify(res.signals);
      if (verdict === 'ok' && res.article)
        return { kind: 'article', content: toArticle(res, requested, r.finalUrl, 'http') };
      return renderFallback(r.finalUrl, { carriedStrong: lv.verdict === 'one-strong', onFail: null });
    };

    const handleHttpError = async (r: Extract<HttpResult, { kind: 'http-error' }>): Promise<FetchOutcome> => {
      const code = httpErrorCode(r.status);
      const original = skipped(code, { status: r.status }, r.finalUrl);
      const lv0 = classifyLogin([...httpSignals(r.status, r.headers), ...urlSignals(r.finalUrl, href, sigs)], 0);
      if (lv0.verdict === 'login-required') return skipped('login-required', { proxy: lv0.proxy }, r.finalUrl);
      if (code === 'http-not-found' || code === 'http-gone') return original;
      let challenge = false;
      let oneStrong = lv0.verdict === 'one-strong';
      if (r.html && (r.status === 403 || r.status === 429 || r.status === 503)) {
        const res = await readability(r.html, r.finalUrl, signal);
        if (res) {
          const lv = classifyLogin(loginSignals(res, r.finalUrl, href, r.status), res.signals.articleTextLength);
          if (lv.verdict === 'login-required') return skipped('login-required', {}, r.finalUrl);
          oneStrong ||= lv.verdict === 'one-strong';
          challenge = res.signals.challengeMarkers;
        }
      }
      // §3 step 5: 403/429 without login signals, or a bot challenge, get the render fallback.
      if (challenge || r.status === 403 || r.status === 429) {
        return renderFallback(r.finalUrl, { carriedStrong: oneStrong, onFail: original });
      }
      return original;
    };

    try {
      // §4.4 rule 4: a user-typed private or loopback URL is allowed (a local dev server).
      allowPrivate = await isPrivateTarget(href, lookup);
      slot = await politeness.acquire(href, signal);
      let r: HttpResult | null = null;
      let retried = false;
      for (;;) {
        await slot.beforeRequest(signal);
        ctx.onProgress?.({ phase: 'http', url: requested });
        r = await httpFetch(
          href,
          {
            transport: deps.transport,
            lookup,
            headers: deps.headers,
            loginSignatures: sigs,
            limits: L,
            ...(deps.log ? { log: deps.log } : {}),
          },
          { jobId: ctx.jobId, signal, stagingDir: ctx.stagingDir, allowPrivate },
        );
        if (retried) break;
        let delay: number | null = null;
        if (r.kind === 'skip' && r.netKind && isRetryableNet(r.netKind)) delay = L.RETRY_NETWORK_DELAY_MS;
        if (r.kind === 'http-error' && (r.status === 429 || r.status === 503)) {
          const ra = parseRetryAfter(r.headers['retry-after'], now());
          if (ra !== null && ra <= L.RETRY_AFTER_MAX_MS) delay = ra;
        } else if (r.kind === 'http-error' && r.status >= 500) delay = L.RETRY_5XX_DELAY_MS;
        if (delay === null || now() + delay >= budgetEnd) break;
        retried = true;
        deps.log?.debug('fetch.retry', { jobId: ctx.jobId, attempt: 2, durationMs: delay });
        await sleep(delay, signal);
      }
      let out: FetchOutcome;
      switch (r.kind) {
        case 'skip':
          out = skipped(r.code, r.detail, r.finalUrl);
          break;
        case 'binary':
          out = { kind: 'binary', content: { ...r.content, requestedUrl: requested } };
          break;
        case 'http-error':
          out = await handleHttpError(r);
          break;
        case 'html':
          out = await handleHtml(r);
          break;
      }
      deps.log?.debug('fetch.done', {
        jobId: ctx.jobId,
        sourceRef: logUrl(href),
        kind: out.kind,
        code: out.kind === 'skipped' ? out.code : null,
        durationMs: now() - started,
      });
      return out;
    } catch (e) {
      if (ctx.signal.aborted) throw abortError();
      if (budget.signal.aborted) return skipped('timeout');
      throw e;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onCtx);
      slot?.release();
    }
  }

  return {
    fetchUrl(url, ctx) {
      if (ctx.signal.aborted) return Promise.reject(abortError());
      const v = validateUrl(url.trim());
      if (!v.ok) return Promise.resolve(skipped(v.code));
      let cache = jobs.get(ctx.jobId);
      if (!cache) {
        cache = new Map();
        jobs.set(ctx.jobId, cache);
      }
      const hit = cache.get(v.href);
      if (hit) return hit;
      const p = run(url.trim(), v.href, ctx);
      cache.set(v.href, p);
      // A cancelled fetch must not poison the cache for a later call.
      p.catch(() => cache.delete(v.href));
      return p;
    },
    async endJob(jobId) {
      jobs.delete(jobId);
      await deps.onJobEnd?.(jobId).catch(() => {});
    },
  };
}
