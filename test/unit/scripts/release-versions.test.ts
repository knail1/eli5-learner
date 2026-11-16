/**
 * The desktop app and the Android companion ship together (16 §11): one version name for both, and
 * an Android versionCode that only ever goes up. RELEASED records what has shipped; the current
 * build must either be one of those exactly or come after all of them in both name and code.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

/** Shipped releases: version name -> Android versionCode. Append one line per release. */
const RELEASED: ReadonlyArray<readonly [string, number]> = [
  ['0.3.0', 2],
  ['0.4.0', 3],
  ['0.5.0', 4],
];

function gradleField(name: string): string {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, 'm').exec(read('android/app/build.gradle.kts'));
  if (!m) throw new Error(`${name} not found in android/app/build.gradle.kts`);
  return m[1]!.trim();
}

function semver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a plain x.y.z version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const newer = (a: string, b: string): boolean => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

describe('release versions', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const lock = JSON.parse(read('package-lock.json')) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };

  it('package.json and package-lock.json agree', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });

  it('the Android companion has the same version name', () => {
    expect(gradleField('versionName')).toBe(pkg.version);
  });

  it('the recorded releases go up in both name and versionCode', () => {
    for (let i = 1; i < RELEASED.length; i++) {
      const [[pn, pc], [n, c]] = [RELEASED[i - 1]!, RELEASED[i]!];
      expect(newer(n, pn), `${n} after ${pn}`).toBe(true);
      expect(c, `${n} versionCode`).toBeGreaterThan(pc);
    }
  });

  it('the current build is a recorded release, or newer than all of them in name and versionCode', () => {
    const name = gradleField('versionName');
    const code = Number(gradleField('versionCode'));
    expect(Number.isInteger(code)).toBe(true);
    const known = RELEASED.find(([n]) => n === name);
    if (known) {
      expect(code, `versionCode of ${name}`).toBe(known[1]);
      return;
    }
    const [lastName, lastCode] = RELEASED[RELEASED.length - 1]!;
    expect(newer(name, lastName), `${name} after ${lastName}`).toBe(true);
    expect(code, `versionCode of ${name}`).toBeGreaterThan(lastCode);
  });
});
