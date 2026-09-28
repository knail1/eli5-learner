/** Public publishers against the Publisher contract suite (13 §10.2). Stubs are tested as stubs (13 §1.5). */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { LocalPublisher } from '../../src/main/publish';
import { describePublisherContract, type PublisherFixture } from './publisher.contract';

/** Everything under the export folder for `slug`, including stray temp files. */
async function exported(fx: PublisherFixture, slug: string): Promise<string[]> {
  const dir = path.join(fx.exportDir, slug);
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
  } catch {
    return [];
  }
}

describePublisherContract(
  'local',
  async (fx) => new LocalPublisher({ home: fx.root }),
  { id: 'local', kind: 'local', label: 'Export copy', available: true, requiresSignIn: false },
  { delivered: exported },
);
