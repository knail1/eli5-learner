import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

/**
 * Where electron-builder puts the arm64 app (01 §8.3), and a minimal ASAR header reader so the
 * checks need no extra dependency. Not a spec file itself (no `.pkg.ts` suffix).
 */

export const PRODUCT = 'ELI5 Learner';
export const RELEASE = path.resolve('release');
/** ELI5_PACKAGED_APP points the checks at another .app (for example an x64 build in release/mac). */
export const APP = path.resolve(process.env.ELI5_PACKAGED_APP ?? path.join(RELEASE, 'mac-arm64', `${PRODUCT}.app`));
export const EXE = path.join(APP, 'Contents', 'MacOS', PRODUCT);
export const RESOURCES = path.join(APP, 'Contents', 'Resources');
export const ASAR = path.join(RESOURCES, 'app.asar');
export const UNPACKED = path.join(RESOURCES, 'app.asar.unpacked');

/** Every package spec is opt-in: it needs a fresh `npx electron-builder --mac dmg --arm64` run. */
export function requirePackage(): void {
  test.skip(process.env.ELI5_RUN_PACKAGE_TESTS !== '1', 'set ELI5_RUN_PACKAGE_TESTS=1 after packaging');
}

interface AsarNode {
  files?: Record<string, AsarNode>;
  unpacked?: boolean;
  offset?: string;
  size?: number;
}

/**
 * ASAR layout: a Chromium pickle holding the header size, then a pickle holding the JSON header
 * string (uint32 payload size, uint32 string length, UTF-8 bytes), then the packed file data.
 */
function readAsar(file: string): { buf: Buffer; root: AsarNode; dataStart: number } {
  const buf = readFileSync(file);
  const headerSize = buf.readUInt32LE(4);
  const header = buf.subarray(8, 8 + headerSize);
  const root = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString('utf8')) as AsarNode;
  return { buf, root, dataStart: 8 + headerSize };
}

/** Lists the files in an ASAR archive. */
export function listAsar(file: string): { path: string; unpacked: boolean }[] {
  const out: { path: string; unpacked: boolean }[] = [];
  const walk = (node: AsarNode, prefix: string): void => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p);
      else out.push({ path: p, unpacked: child.unpacked === true });
    }
  };
  walk(readAsar(file).root, '');
  return out;
}

/** Reads one packed (not unpacked) text file from an ASAR archive. */
export function readAsarText(file: string, rel: string): string {
  const { buf, root, dataStart } = readAsar(file);
  let node: AsarNode | undefined = root;
  for (const part of rel.split('/')) node = node?.files?.[part];
  if (node?.offset === undefined || node.size === undefined) throw new Error(`${rel} is not packed in the asar`);
  const start = dataStart + Number(node.offset);
  return buf.subarray(start, start + node.size).toString('utf8');
}
