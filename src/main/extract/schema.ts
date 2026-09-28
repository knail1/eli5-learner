/**
 * zod shape of ExtractedContent (04 §2), used by the Extractor contract suite (13 §10.2) and
 * available to callers that receive content across a process boundary.
 */
import { z } from 'zod';
import type { ContentBlock, ListItem } from './types';

const ListItemSchema: z.ZodType<ListItem> = z.lazy(() =>
  z.object({ text: z.string(), children: z.array(ListItemSchema).optional() }).strict(),
);

const NotesSchema = z.object({ kind: z.literal('notes'), text: z.string() }).strict();

export const ContentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('heading'),
        level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
        text: z.string(),
      })
      .strict(),
    z.object({ kind: z.literal('paragraph'), text: z.string(), style: z.enum(['quote', 'code']).optional() }).strict(),
    z.object({ kind: z.literal('list'), ordered: z.boolean(), items: z.array(ListItemSchema) }).strict(),
    z
      .object({
        kind: z.literal('table'),
        caption: z.string().optional(),
        header: z.array(z.string()).optional(),
        rows: z.array(z.array(z.string())),
        truncated: z
          .object({ rows: z.number().int().optional(), cols: z.number().int().optional() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('slide'),
        index: z.number().int().positive(),
        title: z.string().optional(),
        hidden: z.boolean().optional(),
        blocks: z.array(ContentBlockSchema),
        notes: NotesSchema.optional(),
      })
      .strict(),
    NotesSchema,
    z
      .object({
        kind: z.literal('image'),
        imageId: z.string().min(1),
        alt: z.string().optional(),
        origin: z.enum(['embedded', 'standalone', 'page-render']),
      })
      .strict(),
    z
      .object({ kind: z.literal('page'), number: z.number().int().positive(), blocks: z.array(ContentBlockSchema) })
      .strict(),
  ]),
);

export const ImageAssetSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{8}-img-\d+$/),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.instanceof(Uint8Array),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    byteLength: z.number().int().nonnegative(),
    distinctColors: z.number().int().nonnegative().optional(),
    origin: z.enum(['embedded', 'standalone', 'page-render']),
    pageOrSlide: z.number().int().positive().optional(),
  })
  .strict();

export const ExtractedContentSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceRef: z.string(),
    format: z.enum([
      'pptx',
      'docx',
      'xlsx',
      'pdf',
      'pdf-scanned',
      'markdown',
      'text',
      'csv',
      'html',
      'png',
      'jpeg',
      'gif',
      'webp',
      'heic',
      'tiff',
      'bmp',
    ]),
    title: z.string().optional(),
    blocks: z.array(ContentBlockSchema),
    images: z.array(ImageAssetSchema),
    stats: z
      .object({
        chars: z.number().int().nonnegative(),
        approxTokens: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative().optional(),
        scannedPages: z.number().int().nonnegative().optional(),
        slides: z.number().int().nonnegative().optional(),
        sheets: z.number().int().nonnegative().optional(),
        imagesKept: z.number().int().nonnegative(),
        imagesDropped: z.number().int().nonnegative(),
        elapsedMs: z.number().nonnegative(),
      })
      .strict(),
    warnings: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();
