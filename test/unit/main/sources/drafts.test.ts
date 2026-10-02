import { readFile, readdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_MAX_AGE_MS,
  InvalidDraftId,
  discardDraft,
  discardInput,
  draftDir,
  imagePreview,
  mintInputId,
  stageDraftItem,
  stageImage,
  stageText,
  sweepStaleDrafts,
  textPreview,
} from '../../../../src/main/sources/drafts';
import * as fx from './fixtures';

describe('draft staging (03 §6.1, §13)', () => {
  it('stages under <userData>/staging/drafts/<draftId>/<inputId>/pasted-<n>.<ext>', async () => {
    const userData = await fx.tmpDir();
    const a = await stageDraftItem(userData, 'draft-1', 'in-00000001', 'txt', 'hello');
    const b = await stageDraftItem(userData, 'draft-1', 'in-00000002', 'png', fx.png());
    expect(a).toBe(path.join(userData, 'staging', 'drafts', 'draft-1', 'in-00000001', 'pasted-1.txt'));
    expect(b).toBe(path.join(userData, 'staging', 'drafts', 'draft-1', 'in-00000002', 'pasted-2.png'));
    expect(await readFile(a, 'utf8')).toBe('hello');
    expect((await stat(a)).mode & 0o777).toBe(0o600);
  });

  it('stageText returns a text SourceInput with a preview', async () => {
    const userData = await fx.tmpDir();
    const plain = await stageText(userData, { draftId: 'd1', text: 'x'.repeat(50), markup: 'plain' });
    expect(plain).toMatchObject({ kind: 'text', origin: 'paste', markup: 'plain' });
    expect(plain.id).toMatch(/^in-[0-9a-f]{8}$/);
    expect(plain.preview).toBe(`Pasted text: ${'x'.repeat(40)}…`);
    expect(plain.stagedPath.endsWith('.txt')).toBe(true);
    const html = await stageText(userData, { draftId: 'd1', text: '<h1>Title</h1><p>Body</p>', markup: 'html' });
    expect(html.stagedPath.endsWith('.html')).toBe(true);
    expect(html.preview).toBe('Pasted text: Title Body');
  });

  it('stageImage returns an image SourceInput with an HH:MM preview', async () => {
    const userData = await fx.tmpDir();
    const img = await stageImage(userData, 'd1', fx.png(), { now: new Date('2026-01-02T14:02:00Z') });
    expect(img).toMatchObject({ kind: 'image', mediaType: 'image/png', preview: 'Pasted image 14:02' });
  });

  it('discardInput removes only that chip; discardDraft removes the draft; both idempotent', async () => {
    const userData = await fx.tmpDir();
    await stageDraftItem(userData, 'd1', 'in-a', 'txt', 'a');
    await stageDraftItem(userData, 'd1', 'in-b', 'txt', 'b');
    await discardInput(userData, 'd1', 'in-a');
    await discardInput(userData, 'd1', 'in-a');
    expect(await readdir(draftDir(userData, 'd1'))).toEqual(['in-b']);
    await discardDraft(userData, 'd1');
    await discardDraft(userData, 'd1');
    await expect(stat(draftDir(userData, 'd1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['../evil', 'A-UPPER', '', 'a/b', 'x'.repeat(65), '..'])('rejects invalid id %j', async (bad) => {
    const userData = await fx.tmpDir();
    expect(() => draftDir(userData, bad)).toThrow(InvalidDraftId);
    await expect(stageDraftItem(userData, 'ok', bad, 'txt', 'x')).rejects.toBeInstanceOf(InvalidDraftId);
    await expect(discardInput(userData, 'ok', bad)).rejects.toBeInstanceOf(InvalidDraftId);
    await expect(discardDraft(userData, bad)).rejects.toBeInstanceOf(InvalidDraftId);
  });

  it('previews and ids', () => {
    expect(textPreview('  a\n\n b  ')).toBe('Pasted text: a b');
    expect(imagePreview(new Date('2026-01-02T09:05:00Z'))).toBe('Pasted image 09:05');
    expect(mintInputId()).toMatch(/^in-[0-9a-f]{8}$/);
  });
});

describe('sweepStaleDrafts (03 §6.1 step 6)', () => {
  it('deletes drafts older than 24 h and keeps younger ones', async () => {
    const userData = await fx.tmpDir();
    await stageDraftItem(userData, 'old', 'in-a', 'txt', 'a');
    await stageDraftItem(userData, 'young', 'in-b', 'txt', 'b');
    const now = Date.now();
    const old = new Date(now - DRAFT_MAX_AGE_MS - 60_000);
    await utimes(draftDir(userData, 'old'), old, old);
    expect(await sweepStaleDrafts(userData, { now })).toBe(1);
    expect(await readdir(path.join(userData, 'staging', 'drafts'))).toEqual(['young']);
  });

  it('with a launch time, removes every draft from before it and keeps the live one (11 §5.4 kept drafts)', async () => {
    const userData = await fx.tmpDir();
    await stageDraftItem(userData, 'last-session', 'in-a', 'txt', 'a');
    await stageDraftItem(userData, 'live', 'in-b', 'txt', 'b');
    const launch = Date.now() - 1000;
    const before = new Date(launch - 5 * 60_000); // minutes old: the 24 h rule alone would keep it
    await utimes(draftDir(userData, 'last-session'), before, before);
    expect(await sweepStaleDrafts(userData, { before: launch })).toBe(1);
    expect(await readdir(path.join(userData, 'staging', 'drafts'))).toEqual(['live']);
    expect(await readFile(path.join(draftDir(userData, 'live'), 'in-b', 'pasted-1.txt'), 'utf8')).toBe('b');
  });

  it('is a no-op without a drafts root and never touches anything outside it', async () => {
    const userData = await fx.tmpDir();
    await fx.put(userData, 'jobs/j1/inputs/keep.txt', 'k');
    expect(await sweepStaleDrafts(userData, { now: Date.now() + 10 * DRAFT_MAX_AGE_MS })).toBe(0);
    expect(await readFile(path.join(userData, 'jobs/j1/inputs/keep.txt'), 'utf8')).toBe('k');
  });
});
