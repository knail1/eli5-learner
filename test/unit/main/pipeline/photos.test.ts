import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import type { AssetCredit, StockPhotoInput } from '../../../../src/main/document';
import type { DocumentDraftTab } from '../../../../src/main/llm';
import type { PipelinePhotos } from '../../../../src/main/pipeline';
import { makePng } from '../../../fixtures/documents/drafts';
import { validateDocument } from '../../../helpers/doc-validity';
import { defaultScript, fileInput, harness } from './harness';

const opts = { clarifyingInput: '', glossary: false };

const CREDIT: AssetCredit = {
  kind: 'stock-photo',
  title: 'Warehouse shelves',
  creator: 'A. Photographer',
  license: 'by-sa',
  licenseVersion: '4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  sourceUrl: 'https://photos.example/1',
  sourceName: 'Wikimedia Commons',
  via: 'Openverse',
};

/** The default script's ELI5 draft with a photo slot in the first section. */
function scriptWithPhoto() {
  const s = defaultScript();
  const eli5 = structuredClone(s.responses.eli5) as DocumentDraftTab;
  eli5.sections[0]!.blocks.push({
    type: 'photo',
    query: 'warehouse shelves',
    purpose: 'show a stock room',
    alt: 'Shelves stacked with boxes',
  });
  return { ...s, responses: { ...s.responses, eli5 } };
}

function fakePhotos(impl?: PipelinePhotos['resolve']) {
  return {
    available: () => true,
    resolve: vi.fn<PipelinePhotos['resolve']>(
      impl ??
        (async (drafts) => {
          const blockIndex = drafts.eli5!.sections[0]!.blocks.findIndex((b) => b.type === 'photo');
          const photo: StockPhotoInput = {
            slot: `eli5:0:${blockIndex}`,
            mime: 'image/png',
            bytes: makePng(40, 30),
            width: 40,
            height: 30,
            alt: 'Shelves stacked with boxes',
            caption: '',
            credit: CREDIT,
          };
          return { photos: [photo], prompt: 'photo-pick@1' };
        }),
    ),
  };
}

describe('stock photos in the create pipeline (06 §5.4, 07 §7.4)', () => {
  it('resolves photo slots after the drafts and embeds the credited photo', async () => {
    const photos = fakePhotos();
    const h = await harness({ script: scriptWithPhoto(), deps: { photos } });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(photos.resolve).toHaveBeenCalledTimes(1);
    const eli5Call = h.fake.calls.find((c) => c.taskId === 'eli5');
    expect(eli5Call?.system).toMatch(/`photo` block/);
    const slug = job.result?.topicSlug ?? '';
    const meta = await h.lib.getMeta(slug);
    expect(meta.generation.prompts).toContain('photo-pick@1');
    const html = await readFile(h.lib.docPath(slug), 'utf8');
    expect(html).toContain('Illustrative stock photo');
    expect(html).toContain('CC BY-SA 4.0');
    expect(validateDocument(html, meta).errors).toEqual([]);
  });

  it('never fails the job when photo resolution fails', async () => {
    const photos = fakePhotos(async () => {
      throw new Error('network down');
    });
    const h = await harness({ script: scriptWithPhoto(), deps: { photos } });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.warnings).toEqual([]);
    const html = await readFile(h.lib.docPath(job.result?.topicSlug ?? ''), 'utf8');
    expect(html).not.toContain('Illustrative stock photo');
  });

  it('with the setting off: diagram-only prompts and no photo search', async () => {
    const photos = fakePhotos();
    const settings = { ...DEFAULTS, images: { stockPhotos: false } };
    const h = await harness({ script: scriptWithPhoto(), deps: { photos, settings: () => settings } });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    expect((await h.finished(jobId)).status).toBe('done');
    expect(photos.resolve).not.toHaveBeenCalled();
    expect(h.fake.calls.find((c) => c.taskId === 'eli5')?.system).toMatch(/Do not use `photo` blocks/);
  });

  it('treats a stub provider (HOOK-DOC-03) as off', async () => {
    const photos = { ...fakePhotos(), available: () => false };
    const h = await harness({ script: scriptWithPhoto(), deps: { photos } });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    expect((await h.finished(jobId)).status).toBe('done');
    expect(photos.resolve).not.toHaveBeenCalled();
  });
});
