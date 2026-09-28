import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, onTestFinished } from 'vitest';

/**
 * Fresh temp library root and userData per test (13 §3.2). Sets ELI5_LIBRARY_DIR and
 * ELI5_USER_DATA_DIR for the code under test and removes everything when the test finishes. Call it
 * from a test or beforeEach (cleanup via onTestFinished) or at suite level (cleanup via afterEach).
 */
export async function tmpLibrary(): Promise<{ root: string; libraryDir: string; userData: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'eli5-test-'));
  const libraryDir = path.join(root, 'docs');
  const userData = path.join(root, 'userData');
  await mkdir(libraryDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  const prev = { lib: process.env.ELI5_LIBRARY_DIR, ud: process.env.ELI5_USER_DATA_DIR };
  process.env.ELI5_LIBRARY_DIR = libraryDir;
  process.env.ELI5_USER_DATA_DIR = userData;
  const cleanup = async (): Promise<void> => {
    restore('ELI5_LIBRARY_DIR', prev.lib);
    restore('ELI5_USER_DATA_DIR', prev.ud);
    await rm(root, { recursive: true, force: true });
  };
  try {
    onTestFinished(cleanup);
  } catch {
    afterEach(cleanup);
  }
  return { root, libraryDir, userData };
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
