#!/usr/bin/env node
// check-spec-hooks.mjs: validate the public-spec <-> private-spec hook contract.
//
// Public side (always runs):
//   - Every "<!-- hook:HOOK-XX-NN -->" marker in spec/*.md and spec/tech/*.md is
//     defined exactly once and is followed by a "> **Private hook · HOOK-XX-NN ·" line.
//   - Every HOOK-XX-NN mentioned anywhere in the public spec is defined.
//   - spec/tech/hooks.md lists every defined hook and nothing undefined.
//
// Private side (only when spec/internal.md exists, i.e. on the author's machine):
//   - Every defined hook has a heading in internal.md containing its ID; orphan
//     bindings (headings for undefined IDs) are reported.
//   - Terms listed under "## Public denylist" in internal.md must not appear in any
//     public (tracked or untracked-but-not-ignored) file. The denylist lives ONLY in
//     internal.md; this script is public and must never hard-code it.
//
// Dependency-free. Node >= 20. Exit 1 on failure, 0 otherwise.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_DIR = join(ROOT, 'spec');
const TECH_DIR = join(SPEC_DIR, 'tech');
const INTERNAL = join(SPEC_DIR, 'internal.md');
const HOOKS_INDEX = join(TECH_DIR, 'hooks.md');

const ID = String.raw`HOOK-[A-Z]+-\d{2}`;
const MARKER_RE = new RegExp(String.raw`<!--\s*hook:(${ID})\s*-->`, 'g');
const MENTION_RE = new RegExp(String.raw`\b(${ID})\b`, 'g');
const HEADING_ID_RE = new RegExp(String.raw`^#{1,6}\s+.*?\b(${ID})\b`);

const errors = [];
const fail = (msg) => errors.push(msg);
const rel = (p) => relative(ROOT, p) || p;

function listMd(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))
    .filter((p) => p !== INTERNAL && statSync(p).isFile())
    .sort();
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// ---------------------------------------------------------------- public checks
const publicFiles = [...listMd(SPEC_DIR), ...listMd(TECH_DIR)];
const defs = new Map(); // id -> [{file, line}]
const mentions = new Map(); // id -> [{file, line}]

for (const file of publicFiles) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  for (const m of text.matchAll(MARKER_RE)) {
    const id = m[1];
    const line = lineOf(text, m.index);
    if (!defs.has(id)) defs.set(id, []);
    defs.get(id).push({ file, line });

    // Next non-empty line after the marker line.
    let j = line; // 0-based index of the line after the marker
    while (j < lines.length && lines[j].trim() === '') j++;
    const expected = `> **Private hook · ${id} ·`;
    if (j >= lines.length || !lines[j].trimStart().startsWith(expected)) {
      fail(`${rel(file)}:${line}: marker for ${id} must be followed by a line starting with "${expected}"`);
    }
  }

  for (const m of text.matchAll(MENTION_RE)) {
    const id = m[1];
    if (!mentions.has(id)) mentions.set(id, []);
    mentions.get(id).push({ file, line: lineOf(text, m.index) });
  }
}

for (const [id, where] of defs) {
  if (where.length > 1) {
    fail(`${id} is defined ${where.length} times: ${where.map((w) => `${rel(w.file)}:${w.line}`).join(', ')}`);
  }
}

for (const [id, where] of mentions) {
  if (!defs.has(id)) {
    const at = where
      .slice(0, 3)
      .map((w) => `${rel(w.file)}:${w.line}`)
      .join(', ');
    fail(`${id} is mentioned but never defined (${at}${where.length > 3 ? ', ...' : ''})`);
  }
}

// hooks.md registry
if (!existsSync(HOOKS_INDEX)) {
  fail(`${rel(HOOKS_INDEX)} is missing; it must list every defined hook`);
} else {
  const idx = readFileSync(HOOKS_INDEX, 'utf8');
  const listed = new Set([...idx.matchAll(MENTION_RE)].map((m) => m[1]));
  for (const id of defs.keys()) {
    if (!listed.has(id)) fail(`${rel(HOOKS_INDEX)} does not list defined hook ${id}`);
  }
  for (const id of listed) {
    if (!defs.has(id)) fail(`${rel(HOOKS_INDEX)} lists ${id}, which is not defined by any marker`);
  }
}

// ---------------------------------------------------------------- private checks
let privateNote = 'private checks skipped';
if (!existsSync(INTERNAL)) {
  console.log('private spec not present: skipping binding and denylist checks');
} else {
  const internal = readFileSync(INTERNAL, 'utf8').replace(/\r\n/g, '\n');
  const ilines = internal.split('\n');

  // (a) bindings
  const bound = new Set();
  let inFence = false;
  for (const l of ilines) {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    if (inFence) continue;
    const m = l.match(HEADING_ID_RE);
    if (m) bound.add(m[1]);
  }
  let missing = 0;
  let orphans = 0;
  for (const id of defs.keys()) {
    if (!bound.has(id)) {
      missing++;
      fail(`spec/internal.md has no binding heading for ${id}`);
    }
  }
  for (const id of bound) {
    if (!defs.has(id)) {
      orphans++;
      fail(`spec/internal.md has an orphan binding for ${id} (not defined in the public spec)`);
    }
  }

  // (b) denylist, read only from internal.md
  const terms = [];
  let inDeny = false;
  for (const l of ilines) {
    if (/^##\s+Public denylist\s*$/i.test(l.trim())) {
      inDeny = true;
      continue;
    }
    if (inDeny && /^#{1,2}\s/.test(l)) break;
    if (!inDeny) continue;
    const b = l.match(/^\s*-\s+(.*)$/);
    if (!b) continue;
    let t = b[1]
      .trim()
      .replace(/^`(.*)`$/, '$1')
      .trim();
    if (t) terms.push(t);
  }
  if (!inDeny) {
    fail(`spec/internal.md has no "## Public denylist" section`);
  }

  // Tracked files plus untracked-but-not-ignored ones (catches leaks before `git add`).
  let files = [];
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    files = [...new Set(out.split('\0').filter(Boolean))];
  } catch (e) {
    fail(`could not run "git ls-files": ${e.message}`);
  }

  const mask = (t) => (t.length <= 2 ? '*'.repeat(t.length) : t[0] + '*'.repeat(t.length - 2) + t[t.length - 1]);
  const needles = terms.map((t) => t.toLowerCase());
  let hits = 0;
  for (const f of files) {
    if (f === 'spec/internal.md') continue;
    const abs = join(ROOT, f);
    let buf;
    try {
      if (!statSync(abs).isFile()) continue;
      buf = readFileSync(abs);
    } catch {
      continue; // deleted in working tree, or unreadable
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const lower = buf.toString('utf8').toLowerCase();
    needles.forEach((n, i) => {
      let from = 0;
      let k;
      while ((k = lower.indexOf(n, from)) !== -1) {
        hits++;
        fail(`${f}:${lineOf(lower, k)}: contains denylisted term #${i + 1} ("${mask(terms[i])}")`);
        from = k + n.length;
      }
    });
  }
  privateNote = `private: ${bound.size} bindings (${missing} missing, ${orphans} orphan), ${terms.length} denylist terms over ${files.length} files (${hits} hits)`;
}

// ---------------------------------------------------------------- report
for (const e of errors) console.error(`FAIL ${e}`);
const summary = `check-spec-hooks: ${defs.size} hooks defined across ${publicFiles.length} public spec files; ${privateNote}; ${errors.length} error(s)`;
if (errors.length) {
  console.error(summary);
  process.exit(1);
}
console.log(summary);
process.exit(0);
