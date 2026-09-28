// check-hygiene.ts: public-repo hygiene gate (13 §11, 12 §12). Run in CI job `hygiene` and pre-push:
//
//   npx jiti scripts/check-hygiene.ts [--out out] [--package]
//
// 1. Tracked-file rules: no tracked enterprise/**, docs/** (except config/hygiene-allow paths), .env*,
//    spec/internal.md, key material or local config.
// 2. Secret scan: the baseline SecretScanner rules (10 §5.4) over tracked files and out/**,
//    minus the per-file, per-rule exceptions in config/hygiene-allow.
// 3. Deny-list (HOOK-CFG-03): terms from ELI5_HYGIENE_DENYLIST (inline, or `@path` to a file)
//    over the contents and paths of tracked files and out/**, case-insensitive. Skipped with a
//    notice when unset; set but empty is a configuration error. Findings name the term's index
//    only, because CI logs of a public repo are public.
// 4. Bundle check: out/main/build-info.json (written by config/electron.vite.config.ts) records that
//    `@eli5/overlay` resolved to overlay.none in a public build with no module from outside src/;
//    out/** also has no leftover overlay path and (with --package) no FakeProvider.
//
// Exit 1 on any finding, 2 on a usage or configuration error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
// The scanner is a leaf of the publish module; its index pulls in the app's edition registry.
import { scanText } from '../src/main/publish/scanner';

export type HygieneCheck = 'tracked-path' | 'secret' | 'denylist' | 'bundle';

export interface HygieneFinding {
  check: HygieneCheck;
  /** Repo-relative, `/`-separated. */
  path: string;
  line?: number;
  /** Never contains a secret value or a deny-list term. */
  detail: string;
}

export interface TextFile {
  path: string;
  text: string;
}

export interface SecretAllow {
  glob: string;
  rule: string;
  /** Masked preview (scanner `maskPreview`) pinning the exception to one reviewed value. */
  preview?: string;
}

export interface AllowList {
  /** Tracked docs/ paths allowed; a trailing `/` allows a directory. */
  paths: string[];
  secrets: SecretAllow[];
}

/**
 * `config/hygiene-allow`: one docs path per line, or `secret <glob> <rule-id> [<preview>]`. `#` at the
 * start of a line or after whitespace starts a comment (a preview may itself contain `#`).
 */
export function parseAllowFile(text: string): AllowList {
  const out: AllowList = { paths: [], secrets: [] };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts[0] === 'secret') {
      const [, glob, rule, preview, ...rest] = parts;
      if (!glob || !rule || rest.length > 0) {
        throw new Error(`config/hygiene-allow line ${i + 1}: expected "secret <glob> <rule-id> [<preview>]"`);
      }
      out.secrets.push(preview === undefined ? { glob, rule } : { glob, rule, preview });
    } else {
      out.paths.push(line);
    }
  });
  return out;
}

/** Glob to RegExp: `**` spans directories, `*` stays within one segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** Tracked-path rules (13 §11 rule 1; 12 §12 table). Returns the reason, or null when allowed. */
function trackedPathReason(p: string, allow: readonly string[]): string | null {
  if (p.startsWith('docs/')) {
    const ok = allow.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a));
    return ok ? null : 'generated docs/ output is not committed (only config/hygiene-allow paths)';
  }
  if (p.startsWith('enterprise/')) return 'the enterprise overlay is private (HOOK-CFG-02)';
  if (p === 'spec/internal.md') return 'the private spec is never committed';
  if (p.startsWith('.library/')) return 'the dev library holds generated learnings';
  const name = basename(p);
  if (name.startsWith('.env') && name !== '.env.example') return 'env files are never committed';
  if (/\.(pem|p12|key)$/i.test(name)) return 'key material is never committed';
  if (name === 'config.local.json' || name === 'CLAUDE.local.md') return 'local config is never committed';
  return null;
}

export function checkTrackedPaths(paths: readonly string[], allow: readonly string[]): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const p of paths) {
    const reason = trackedPathReason(p, allow);
    if (reason) out.push({ check: 'tracked-path', path: p, detail: `tracked file not allowed: ${reason}` });
  }
  return out;
}

export function scanSecrets(files: readonly TextFile[], allow: readonly SecretAllow[]): HygieneFinding[] {
  const compiled = allow.map((a) => ({ re: globToRegExp(a.glob), rule: a.rule, preview: a.preview }));
  const out: HygieneFinding[] = [];
  for (const f of files) {
    for (const s of scanText(f.path, f.text)) {
      const allowed = compiled.some(
        (a) => a.rule === s.rule && a.re.test(f.path) && (a.preview === undefined || a.preview === s.preview),
      );
      if (allowed) continue;
      out.push({ check: 'secret', path: f.path, line: s.line, detail: `${s.rule} (${s.preview})` });
    }
  }
  return out;
}

/**
 * HOOK-CFG-03: inline newline-separated terms, or `@/path/to/list`. Null when unset; throws when
 * set but yielding no terms, so a misconfigured secret never reads as a passing scan.
 */
export function loadDenylist(value: string | undefined): string[] | null {
  if (value === undefined || value.trim() === '') return null;
  let text = value;
  if (value.trimStart().startsWith('@')) {
    const file = value.trim().slice(1);
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new Error('ELI5_HYGIENE_DENYLIST names a file that cannot be read');
    }
  }
  const terms = text
    .split(/\r?\n/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '' && !t.startsWith('#'));
  if (terms.length === 0) throw new Error('ELI5_HYGIENE_DENYLIST is set but has no terms');
  return terms;
}

export function scanDenylist(files: readonly TextFile[], terms: readonly string[]): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const f of files) {
    f.text.split(/\r\n|\n|\r/).forEach((lineText, i) => {
      const lower = lineText.toLowerCase();
      terms.forEach((term, t) => {
        if (lower.includes(term)) {
          out.push({ check: 'denylist', path: f.path, line: i + 1, detail: `matches deny-list term #${t + 1}` });
        }
      });
    });
  }
  return out;
}

/** File and directory names (binaries included) against the terms; reports the index only. */
export function scanDenylistPaths(paths: readonly string[], terms: readonly string[]): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    terms.forEach((term, t) => {
      if (lower.includes(term))
        out.push({ check: 'denylist', path: p, detail: `path matches deny-list term #${t + 1}` });
    });
  }
  return out;
}

/** Where config/electron.vite.config.ts records the main build's resolved edition and overlay. */
export const BUILD_INFO = 'main/build-info.json';
const PUBLIC_OVERLAY = 'src/main/editions/overlay.none.ts';

/**
 * 13 §11 rule 4 from the resolved module ids: Vite inlines the overlay's code and leaves no path
 * behind, so the bundle text alone cannot show which module `@eli5/overlay` became.
 */
export function checkBuildInfo(info: unknown, path: string): HygieneFinding[] {
  const finding = (detail: string): HygieneFinding => ({ check: 'bundle', path, detail });
  if (info === undefined) return [finding('build-info.json missing: cannot verify the @eli5/overlay resolution')];
  const r = info as { edition?: unknown; overlay?: unknown; foreign?: unknown };
  if (
    typeof r !== 'object' ||
    r === null ||
    typeof r.edition !== 'string' ||
    !(typeof r.overlay === 'string' || r.overlay === null) ||
    !Array.isArray(r.foreign)
  ) {
    return [finding('build-info.json is malformed: cannot verify the @eli5/overlay resolution')];
  }
  const out: HygieneFinding[] = [];
  if (r.edition !== 'public') out.push(finding('bundle was built for a non-public edition'));
  if (r.overlay !== PUBLIC_OVERLAY)
    out.push(finding(`@eli5/overlay resolved to something other than ${PUBLIC_OVERLAY}`));
  // Paths are not printed: for a private overlay they would be private file names.
  if (r.foreign.length > 0)
    out.push(finding(`${r.foreign.length} bundled module(s) from outside src/ and node_modules`));
  return out;
}

/** Leftover path markers (13 §11 rule 4), a second line behind checkBuildInfo. */
const OVERLAY_MARKERS: readonly { re: RegExp; detail: string }[] = [
  { re: /@eli5\/overlay/, detail: '@eli5/overlay left unresolved in the public bundle' },
  { re: /overlay-fake/, detail: 'fixture overlay referenced by the public bundle' },
  { re: /(^|[^a-z])enterprise\/index(\.ts)?\b/, detail: 'enterprise overlay referenced by the public bundle' },
];

export function checkBundle(files: readonly TextFile[], opts: { packageMode: boolean }): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const f of files) {
    f.text.split(/\r\n|\n|\r/).forEach((lineText, i) => {
      for (const m of OVERLAY_MARKERS) {
        if (m.re.test(lineText)) out.push({ check: 'bundle', path: f.path, line: i + 1, detail: m.detail });
      }
      if (opts.packageMode && lineText.includes('FakeProvider')) {
        out.push({ check: 'bundle', path: f.path, line: i + 1, detail: 'FakeProvider present in a package build' });
      }
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ I/O

/** Skipped without decoding, as in 10 §5.4. */
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.woff', '.woff2', '.ttf']);

async function readText(abs: string, rel: string): Promise<TextFile | null> {
  if (BINARY_EXTS.has(extname(rel).toLowerCase())) return null;
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return null; // tracked but deleted in the working tree, or a submodule directory
  }
  if (buf.subarray(0, 8192).includes(0)) return null;
  return { path: rel, text: buf.toString('utf8') };
}

function trackedFiles(root: string): string[] {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return raw.toString('utf8').split('\0').filter(Boolean).sort();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

export interface RunHygieneOptions {
  root: string;
  env: Record<string, string | undefined>;
  /** Built bundle directory relative to root (CI: `out`); omitted skips the out/** scans. */
  outDir?: string;
  /** The bundle is a package build: FakeProvider must be absent. */
  packageMode?: boolean;
  log: (line: string) => void;
}

export interface HygieneResult {
  ok: boolean;
  findings: HygieneFinding[];
}

export async function runHygiene(opts: RunHygieneOptions): Promise<HygieneResult> {
  const { root, log } = opts;
  const allowPath = join(root, 'config', 'hygiene-allow');
  const allow = existsSync(allowPath) ? parseAllowFile(readFileSync(allowPath, 'utf8')) : { paths: [], secrets: [] };

  const tracked = trackedFiles(root);
  const trackedText = (await Promise.all(tracked.map((p) => readText(join(root, p), p)))).filter(
    (f): f is TextFile => f !== null,
  );

  let outText: TextFile[] = [];
  let outPaths: string[] = [];
  let buildInfo: { path: string; value: unknown } | undefined;
  if (opts.outDir !== undefined) {
    const outAbs = resolve(root, opts.outDir);
    if (!existsSync(outAbs) || !(await stat(outAbs)).isDirectory()) {
      throw new Error(`bundle directory ${opts.outDir} not found; build first`);
    }
    const files = await walk(outAbs);
    const toRel = (abs: string): string => relative(root, abs).split(sep).join('/');
    outPaths = files.map(toRel);
    outText = (await Promise.all(files.map((abs) => readText(abs, toRel(abs))))).filter(
      (f): f is TextFile => f !== null,
    );
    const infoAbs = join(outAbs, BUILD_INFO);
    let value: unknown;
    if (existsSync(infoAbs)) {
      try {
        value = JSON.parse(readFileSync(infoAbs, 'utf8')) as unknown;
      } catch {
        value = null; // reported as malformed
      }
    }
    buildInfo = { path: toRel(infoAbs), value };
  }

  const findings: HygieneFinding[] = [
    ...checkTrackedPaths(tracked, allow.paths),
    ...scanSecrets([...trackedText, ...outText], allow.secrets),
  ];

  const terms = loadDenylist(opts.env.ELI5_HYGIENE_DENYLIST);
  if (terms === null) log('hygiene: deny-list scan skipped (ELI5_HYGIENE_DENYLIST is not set)');
  else {
    log(`hygiene: deny-list scan with ${terms.length} term(s)`);
    findings.push(
      ...scanDenylist([...trackedText, ...outText], terms),
      ...scanDenylistPaths([...tracked, ...outPaths], terms),
    );
  }

  if (buildInfo !== undefined) findings.push(...checkBuildInfo(buildInfo.value, buildInfo.path));
  if (opts.outDir !== undefined) findings.push(...checkBundle(outText, { packageMode: opts.packageMode === true }));

  for (const f of findings) log(`hygiene: [${f.check}] ${f.path}${f.line ? `:${f.line}` : ''} ${f.detail}`);
  const scope = `${tracked.length} tracked files${opts.outDir !== undefined ? ` and ${outText.length} bundle files` : ''}`;
  log(findings.length === 0 ? `hygiene: ok (${scope})` : `hygiene: ${findings.length} finding(s) in ${scope}`);
  return { ok: findings.length === 0, findings };
}

// ------------------------------------------------------------------------------------------ CLI

function parseArgs(argv: readonly string[]): { outDir?: string; packageMode: boolean } {
  const out: { outDir?: string; packageMode: boolean } = { packageMode: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--package') out.packageMode = true;
    else if (a === '--out' && argv[i + 1] !== undefined) out.outDir = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = resolve(import.meta.dirname, '..');
    const r = await runHygiene({ root, env: process.env, ...args, log: (l) => console.log(l) });
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    console.error(`hygiene: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
