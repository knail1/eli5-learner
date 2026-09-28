/** Default lane router (03 §8, HOOK-SRC-03). Public: no rules, every URL -> web lane. */
import type { LaneRoute, LaneRouter, LaneRule } from './types';

/** No-rule default (03 §8 step 2). */
export const WEB_ROUTE: Readonly<LaneRoute> = Object.freeze({ lane: 'web', noWebFallback: false });

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Host glob -> anchored RegExp over the lowercased host. `*` matches one or more characters,
 * so `*.example.internal` matches any subdomain but not the apex (03 §8 step 1).
 */
export function compileHostGlob(glob: string): RegExp {
  const src = glob.toLowerCase().split('*').map(escapeRegExp).join('.+');
  return new RegExp(`^${src}$`);
}

interface CompiledRule {
  rule: LaneRule;
  host?: RegExp;
  pathPrefix?: string;
  pattern?: RegExp;
}

function compile(rule: LaneRule): CompiledRule {
  const { hostGlob, pathPrefix, pattern } = rule.match;
  if (hostGlob === undefined && pathPrefix === undefined && pattern === undefined) {
    throw new Error(`Lane rule "${rule.id}" has an empty match`);
  }
  const c: CompiledRule = { rule };
  if (hostGlob !== undefined) c.host = compileHostGlob(hostGlob);
  if (pathPrefix !== undefined) c.pathPrefix = pathPrefix;
  if (pattern !== undefined) {
    try {
      c.pattern = new RegExp(pattern);
    } catch (err) {
      throw new Error(`Lane rule "${rule.id}" has an invalid pattern: ${(err as Error).message}`);
    }
  }
  return c;
}

/** All present match fields must hold. */
function matches(c: CompiledRule, url: URL): boolean {
  if (c.host && !c.host.test(url.hostname.toLowerCase())) return false;
  if (c.pathPrefix !== undefined && !url.pathname.startsWith(c.pathPrefix)) return false;
  if (c.pattern && !c.pattern.test(url.href)) return false;
  return true;
}

/**
 * Build the default router from an ordered rule list; first match wins (03 §8).
 * Throws on malformed rules so a bad overlay rule list fails at bootstrap.
 * routeBare() is always null: bare identifiers need an overlay router (registerLaneRouter).
 */
export function buildLaneRouter(rules: readonly LaneRule[]): LaneRouter {
  const compiled = rules.map(compile);
  return {
    route(url: URL): LaneRoute {
      for (const c of compiled) {
        if (matches(c, url)) return { ...c.rule.route, ruleId: c.rule.id };
      }
      return { ...WEB_ROUTE };
    },
    routeBare(_text: string) {
      return null;
    },
  };
}
