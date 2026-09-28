import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyUserData } from '../../../../src/main/config/paths';

/**
 * Early builds had no productName, so Electron named the data folder after the package
 * ("eli5-learner"). With productName "ELI5 Learner" the folder moves; the data must follow once.
 */
let appData: string;
const legacy = (): string => join(appData, 'eli5-learner');
const target = (): string => join(appData, 'ELI5 Learner');
const seedLegacy = (): void => {
  mkdirSync(join(legacy(), 'docs', 'a-doc'), { recursive: true });
  writeFileSync(join(legacy(), 'settings.json'), '{"schemaVersion":1}');
  writeFileSync(join(legacy(), 'docs', 'a-doc', 'index.html'), '<!doctype html>');
};
const run = (alive = (_pid: number) => false) =>
  migrateLegacyUserData({ appData, target: target(), legacyNames: ['eli5-learner'], isAlive: alive, hostname: 'mac' });

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'eli5-appdata-'));
});
afterEach(() => rmSync(appData, { recursive: true, force: true }));

describe('migrateLegacyUserData', () => {
  it('moves the legacy folder when the new one does not exist', () => {
    seedLegacy();
    expect(run()).toEqual({ status: 'moved', from: legacy() });
    expect(readFileSync(join(target(), 'docs', 'a-doc', 'index.html'), 'utf8')).toBe('<!doctype html>');
    expect(existsSync(join(target(), 'settings.json'))).toBe(true);
    expect(existsSync(legacy())).toBe(false);
  });

  it('moves into an empty shell that Electron may have created first', () => {
    seedLegacy();
    mkdirSync(join(target(), 'Cache'), { recursive: true });
    expect(run().status).toBe('moved');
    expect(existsSync(join(target(), 'docs', 'a-doc', 'index.html'))).toBe(true);
    expect(existsSync(join(target(), 'Cache'))).toBe(true);
    expect(existsSync(legacy())).toBe(false);
  });

  it('never overwrites a new folder that already has a library or settings', () => {
    seedLegacy();
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), 'settings.json'), '{"new":true}');
    expect(run().status).toBe('skipped-target-in-use');
    expect(readFileSync(join(target(), 'settings.json'), 'utf8')).toBe('{"new":true}');
    expect(existsSync(join(legacy(), 'docs', 'a-doc', 'index.html'))).toBe(true);
  });

  it('does nothing when there is no legacy folder', () => {
    expect(run().status).toBe('nothing-to-migrate');
    expect(existsSync(target())).toBe(false);
  });

  it('leaves a legacy profile alone while the old app is still running', () => {
    seedLegacy();
    symlinkSync('mac-4242', join(legacy(), 'SingletonLock'));
    expect(run((pid) => pid === 4242).status).toBe('skipped-legacy-running');
    expect(existsSync(join(legacy(), 'settings.json'))).toBe(true);
    expect(existsSync(target())).toBe(false);
  });

  it('moves a legacy profile whose lock is stale (process gone)', () => {
    seedLegacy();
    symlinkSync('mac-4242', join(legacy(), 'SingletonLock'));
    expect(run(() => false).status).toBe('moved');
    expect(existsSync(join(target(), 'settings.json'))).toBe(true);
  });
});
