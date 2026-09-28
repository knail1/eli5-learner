/**
 * Recording drive and git publishers (HOOK-PUB-01/03 mechanism only). They "upload" by recording
 * the file list, after the secret scan remote targets must run (10 §5.3 step 4, 13 §10.2). Links
 * use reserved `.test` hosts.
 */
import { createHash } from 'node:crypto';
import type { Settings } from '@eli5/public/config';
import type { PublishContext, Publisher, PublishResult, PublishTarget, SecretScanner } from '@eli5/public/publish';
import { PublishError } from '@eli5/public/publish';

export interface RecordedUpload {
  targetId: string;
  slug: string;
  files: string[];
  at: string;
}

export class PublishRecorder {
  readonly uploads: RecordedUpload[] = [];

  /** Files of the latest upload of `slug` to `targetId`; [] when nothing was uploaded. */
  lastFiles(targetId: string, slug: string): string[] {
    const hit = this.uploads.filter((u) => u.targetId === targetId && u.slug === slug).at(-1);
    return hit ? [...hit.files] : [];
  }

  clear(): void {
    this.uploads.length = 0;
  }
}

const LABELS = { drive: 'Share to cloud drive', git: 'Push to Pages' } as const;

export class RecordingPublisher implements Publisher {
  readonly id: 'drive' | 'git';
  readonly kind: 'drive' | 'git';

  constructor(
    kind: 'drive' | 'git',
    private readonly recorder: PublishRecorder,
    private readonly scanner: () => SecretScanner,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.id = kind;
    this.kind = kind;
  }

  describe(slug: string, _settings: Settings): Promise<PublishTarget> {
    return Promise.resolve({
      id: this.id,
      kind: this.kind,
      label: LABELS[this.kind],
      available: true,
      destinationPreview: this.kind === 'drive' ? `Fixture drive / ${slug}` : `fixture/pages: docs/${slug}/`,
      requiresSignIn: false,
    });
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const cancelled = () => new PublishError('E_PUBLISH_CANCELLED', 'Publish cancelled');
    if (ctx.signal.aborted) throw cancelled();
    ctx.progress('preparing');
    ctx.progress('scanning');
    const findings = await this.scanner().scan(ctx.files, ctx.signal);
    if (findings.length > 0) {
      throw new PublishError(
        'E_PUBLISH_SECRET_FOUND',
        'This document contains something that looks like a secret. Remove it and regenerate the section.',
        undefined,
        findings,
      );
    }
    if (ctx.signal.aborted) throw cancelled();
    ctx.progress(this.kind === 'drive' ? 'uploading' : 'committing');
    ctx.progress(this.kind === 'drive' ? 'sharing' : 'pushing');
    const publishedAt = this.now().toISOString();
    const files = ctx.files.map((f) => f.relPath);
    this.recorder.uploads.push({ targetId: this.id, slug: ctx.slug, files, at: publishedAt });

    const base = { targetId: this.id, kind: this.kind, slug: ctx.slug, publishedAt, files, warnings: [] };
    if (this.kind === 'drive') {
      return {
        ...base,
        links: [
          { kind: 'share', url: `https://drive.example.test/d/${ctx.slug}`, label: 'Shareable link', primary: true },
        ],
        sharing: { scope: 'organization', description: 'Anyone in the fixture organization can view' },
      };
    }
    // Same content, same commit: republishing is idempotent.
    const sha = createHash('sha1')
      .update(ctx.files.map((f) => `${f.relPath}:${f.sha256}`).join('\n'))
      .digest('hex');
    return {
      ...base,
      links: [
        { kind: 'site', url: `https://pages.example.test/${ctx.slug}/`, label: 'Pages URL', primary: true },
        {
          kind: 'commit',
          url: `https://code.example.test/fixture/pages/commit/${sha}`,
          label: 'Commit',
          primary: false,
        },
      ],
      commit: { sha, branch: 'main' },
    };
  }
}
