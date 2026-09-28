#!/usr/bin/env node
// check-licenses.mjs: dependency policy checks from 13 §13, run in CI job `static`.
//
//   node scripts/check-licenses.mjs [--root dir]
//     Every runtime dependency in package-lock.json (entries not marked `dev`) must carry a license
//     on ALLOWED, which lists licenses compatible with shipping under the repo's MIT license.
//     SPDX expressions are evaluated: OR needs one allowed side, AND needs both.
//
//   node scripts/check-licenses.mjs --audit audit.json [--today YYYY-MM-DD]
//     Reads `npm audit --omit=dev --json` output; a high or critical advisory fails unless
//     audit-allow.json lists it with a reason and an expiry date that has not passed. An error
//     object or a report without `vulnerabilities` (registry unreachable) exits 2, never "ok".
//
// Dependency-free. Exit 1 on a policy failure, 2 on a usage or configuration error.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Permissive licenses compatible with an MIT-licensed distribution. */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
  'Zlib',
]);

/** Reviewed packages whose license field is not SPDX, keyed by name, pinned to the exact string. */
const EXCEPTIONS = new Map([
  // Declares the legacy non-SPDX id "BSD"; its LICENSE file is the permissive BSD text.
  ['duck', 'BSD'],
]);

class UsageError extends Error {}

// ------------------------------------------------------------------ SPDX expression evaluation

function tokenize(expr) {
  return expr.match(/\(|\)|[^\s()]+/g) ?? [];
}

/** Grammar: or := and ('OR' and)*; and := atom ('AND' atom)*; atom := '(' or ')' | id ['WITH' id]. */
export function spdxAllowed(expr, allowed = ALLOWED) {
  const tokens = tokenize(expr);
  let i = 0;
  const atom = () => {
    const t = tokens[i++];
    if (t === '(') {
      const v = or();
      if (tokens[i++] !== ')') throw new UsageError(`bad SPDX expression: ${expr}`);
      return v;
    }
    if (t === undefined || t === ')') throw new UsageError(`bad SPDX expression: ${expr}`);
    if (tokens[i] === 'WITH') i += 2; // an exception only adds permissions
    return allowed.has(t.replace(/\+$/, ''));
  };
  const and = () => {
    let v = atom();
    while (tokens[i] === 'AND') {
      i++;
      v = atom() && v;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (tokens[i] === 'OR') {
      i++;
      v = and() || v;
    }
    return v;
  };
  try {
    const v = or();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ runtime license check

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new UsageError(`cannot read ${what} at ${path}`);
  }
}

function licenseOf(root, key, entry) {
  if (typeof entry.license === 'string') return entry.license;
  const pkgPath = join(root, key, 'package.json');
  if (!existsSync(pkgPath)) return 'UNKNOWN';
  const pkg = readJson(pkgPath, 'package.json');
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const ids = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (ids.length > 0) return ids.length === 1 ? ids[0] : `(${ids.join(' OR ')})`;
  }
  return 'UNKNOWN';
}

function checkLicenses(root) {
  const lock = readJson(join(root, 'package-lock.json'), 'package-lock.json');
  if (!lock.packages || typeof lock.packages !== 'object') throw new UsageError('package-lock.json v2+ required');
  const failures = [];
  let count = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.dev || entry.link) continue;
    count++;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const license = licenseOf(root, key, entry);
    if (EXCEPTIONS.get(name) === license) continue;
    if (license === 'UNKNOWN' || !spdxAllowed(license)) failures.push(`${name}@${entry.version ?? '?'}: ${license}`);
  }
  if (failures.length > 0) {
    console.log(`licenses: ${failures.length} runtime package(s) not on the allow list:`);
    for (const f of failures) console.log(`  ${f}`);
    return 1;
  }
  console.log(`licenses: ok (${count} runtime packages)`);
  return 0;
}

// ------------------------------------------------------------------ npm audit allow list

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function loadAuditAllow(root) {
  const path = join(root, 'audit-allow.json');
  if (!existsSync(path)) return [];
  const data = readJson(path, 'audit-allow.json');
  if (!Array.isArray(data.allow)) throw new UsageError('audit-allow.json: "allow" must be an array');
  data.allow.forEach((e, n) => {
    if (typeof e?.package !== 'string' || typeof e?.advisory !== 'string' || typeof e?.reason !== 'string') {
      throw new UsageError(`audit-allow.json entry ${n + 1}: needs package, advisory and reason`);
    }
    if (typeof e.expires !== 'string' || !DATE_RE.test(e.expires)) {
      throw new UsageError(`audit-allow.json entry ${n + 1}: expires must be YYYY-MM-DD`);
    }
  });
  return data.allow;
}

function advisoryId(via) {
  if (typeof via.url === 'string' && via.url.length > 0) return via.url.slice(via.url.lastIndexOf('/') + 1);
  return String(via.source ?? via.title ?? 'unknown');
}

function checkAudit(root, auditPath, today) {
  const report = readJson(auditPath, 'npm audit report');
  // Fail closed: a registry or network error yields an error object, not a report (13 §13).
  if (report?.error !== undefined) {
    const code = typeof report.error?.code === 'string' ? ` (${report.error.code})` : '';
    throw new UsageError(`npm audit did not produce a report${code}; the audit was not run`);
  }
  if (!report || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    throw new UsageError('npm audit report has no vulnerabilities map; the audit was not run');
  }
  const allow = loadAuditAllow(root);
  const failures = [];
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
    // String `via` entries are transitive; the advisory is reported on the package that owns it.
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      if (via.severity !== 'high' && via.severity !== 'critical') continue;
      const id = advisoryId(via);
      const entry = allow.find((e) => e.package === pkg && e.advisory === id);
      if (!entry) failures.push(`${pkg}: ${via.severity} ${id}`);
      else if (entry.expires < today)
        failures.push(`${pkg}: ${via.severity} ${id} (allow entry expired ${entry.expires})`);
    }
  }
  if (failures.length > 0) {
    console.log(`audit: ${failures.length} high or critical advisory(ies) not allowed:`);
    for (const f of failures) console.log(`  ${f}`);
    return 1;
  }
  console.log('audit: ok');
  return 0;
}

// ------------------------------------------------------------------ CLI

function main(argv) {
  let root = process.cwd();
  let audit;
  let today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--root' && next) root = resolve(argv[++i]);
    else if (a === '--audit' && next) audit = resolve(argv[++i]);
    else if (a === '--today' && next && DATE_RE.test(next)) today = argv[++i];
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return audit ? checkAudit(root, audit, today) : checkLicenses(root);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`check-licenses: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = e instanceof UsageError ? 2 : 1;
}
