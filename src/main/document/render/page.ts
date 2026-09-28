// Deterministic DocumentModel -> self-contained index.html (07 §5.5, §6). Pure: no clock reads,
// fixed attribute order and whitespace, canonical model JSON.
import { canonicalJson, scriptSafeJson } from '../canonical-json';
import { attrs, capText, esc } from '../html';
import { DEFAULT_FOOTER, defaultDocTheme, themeCss } from '../theme';
import type { AssetCredit, AssetRef, DocRuntime, DocTheme, DocumentModel, RenderOptions, Section, Tab } from '../types';
import { renderBlock, type MergeMarkup } from './blocks';
import { documentCsp } from './csp';
import { formatDate } from './date';
import { renderReferencesBody } from './references';

export { formatDate };

/** Display cap for section ELI5 tab labels; the full label goes into `title` (07 §4.1). */
export const TAB_LABEL_MAX = 48;

/** Makes inline script text safe inside <script> (never closes the element). */
export function scriptSafe(js: string): string {
  return js.replace(/<(?=\/script|!--)/gi, '\\x3c');
}

/** Makes CSS safe inside <style>. */
export function styleSafe(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

interface Ctx {
  model: DocumentModel;
  assets: ReadonlyMap<string, Uint8Array>;
  assetRefs: ReadonlyMap<string, AssetRef>;
  merges: MergeMarkup;
}

/** "Enhanced on 28 Sep 2026 with material from <title>" (07 §6.4), without markup. */
export function mergeLegendText(m: { fromTitle: string; mergedAt: string }): string {
  return `Enhanced on ${formatDate(m.mergedAt)} with material from ${m.fromTitle}`;
}

/** `<ins>` tags and hover text per merge id; an unknown id still renders a mark. */
function mergeMarkup(model: DocumentModel): MergeMarkup {
  const byId = new Map((model.merges ?? []).map((m) => [m.id, m]));
  const title = (id: string): string => {
    const m = byId.get(id);
    return m ? mergeLegendText(m) : 'Enhanced in a merge';
  };
  const open = new Map<string, string>();
  return {
    title,
    open: (id) => {
      let tag = open.get(id);
      if (tag === undefined) {
        tag = `<ins${attrs([
          ['class', 'enh'],
          ['data-merge', id],
          ['title', title(id)],
        ])}>`;
        open.set(id, tag);
      }
      return tag;
    },
  };
}

function ctxOf(model: DocumentModel, assets: ReadonlyMap<string, Uint8Array>): Ctx {
  return { model, assets, assetRefs: new Map(model.assets.map((a) => [a.id, a])), merges: mergeMarkup(model) };
}

/** Credits of the stock photos some figure shows, in asset order (07 §7.4). */
function shownCredits(model: DocumentModel): AssetCredit[] {
  const shown = new Set<string>();
  for (const t of model.tabs)
    for (const s of t.sections) for (const b of s.blocks) if (b.type === 'figure') shown.add(b.assetId);
  return model.assets.flatMap((a) => (a.credit && shown.has(a.id) ? [a.credit] : []));
}

function sectionHtml(c: Ctx, tab: Tab, s: Section): string {
  const isRefs = s.kind === 'references';
  const open = `<section${attrs([
    ['id', s.id],
    ['data-section-id', s.id],
    ['class', s.mergeMarker ? 'merge-marker' : undefined],
    ['data-kind', isRefs ? 'references' : undefined],
    ['data-origin', s.origin],
    ['data-merged-from', s.merge?.fromDocId],
    ['data-enh', s.enh?.added ? 'new' : undefined],
    ['data-merge', s.enh?.added],
    ['data-merge-marker', s.mergeMarker?.suggestionId],
    ['data-eli5-actionable', isRefs ? 'false' : 'true'],
    ['aria-labelledby', `${s.id}-h`],
  ])}>`;
  const head = `<h2 id="${s.id}-h">${esc(s.heading)}</h2>`;
  let body: string;
  if (isRefs) {
    body = renderReferencesBody(c.model.references, shownCredits(c.model));
  } else {
    const notes = tab.kind === 'indepth' ? c.model.glossary.filter((n) => n.sectionId === s.id) : [];
    body = s.blocks
      .map((b, i) =>
        renderBlock(b, {
          idBase: `${s.id}-b${i}`,
          assets: c.assets,
          assetRefs: c.assetRefs,
          notes: notes.filter((n) => n.blockIndex === i),
          enh: s.enh?.blocks.find((e) => e.block === i),
          merges: c.merges,
        }),
      )
      .join('\n');
  }
  return `${open}\n${head}\n${body}\n</section>`;
}

/** Label shown on a tab button (07 §4.1: section ELI5 labels truncated to 48 characters). */
export function displayLabel(tab: Tab): string {
  return tab.kind === 'section-eli5' ? capText(tab.label, TAB_LABEL_MAX) : tab.label;
}

function tabFrom(c: Ctx, tab: Tab): string {
  if (tab.kind !== 'section-eli5' || !tab.origin) return '';
  const text = tab.label.replace(/^ELI5: /, '').replace(/ \(\d+\)$/, '');
  const exists = c.model.tabs.some((t) => t.sections.some((s) => s.id === tab.origin?.sectionId));
  const target = exists ? `<a href="#${esc(tab.origin.sectionId)}">${esc(text)}</a>` : esc(text);
  return `<p class="tab-from">From: ${target}</p>\n`;
}

function panelHtml(c: Ctx, tab: Tab): string {
  const open = `<div${attrs([
    ['class', 'tabpanel'],
    ['role', 'tabpanel'],
    ['id', `tab-${tab.key}`],
    ['data-tab-key', tab.key],
    ['data-tab-kind', tab.kind],
    ['aria-labelledby', `tabbtn-${tab.key}`],
    ['tabindex', 0],
  ])}>`;
  const title = `<h2 class="panel-title">${esc(tab.label)}</h2>`;
  const sections = tab.sections.map((s) => sectionHtml(c, tab, s)).join('\n');
  return `${open}\n${title}\n${tabFrom(c, tab)}${sections}\n</div>`;
}

function tabButton(tab: Tab, first: boolean): string {
  const label = displayLabel(tab);
  const btn = `<button${attrs([
    ['type', 'button'],
    ['role', 'tab'],
    ['id', `tabbtn-${tab.key}`],
    ['aria-controls', `tab-${tab.key}`],
    ['aria-selected', first ? 'true' : 'false'],
    ['tabindex', first ? 0 : -1],
    ['title', label !== tab.label ? tab.label : undefined],
  ])}>${esc(label)}</button>`;
  if (tab.kind !== 'section-eli5') return btn;
  const close = `<button${attrs([
    ['type', 'button'],
    ['class', 'tab-close'],
    ['data-close-tab', tab.key],
    ['aria-label', `Close tab ${tab.label}`],
    ['hidden', true],
  ])}>×</button>`;
  return `<span class="tab-sx">${btn}${close}</span>`;
}

function metaLine(model: DocumentModel): string {
  const used = model.references.filter((r) => r.status === 'used').length;
  const skipped = model.references.filter((r) => r.status === 'skipped').length;
  const parts = [`Generated ${formatDate(model.createdAt)}`, `${used} ${used === 1 ? 'source' : 'sources'}`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(' · ');
}

/** Footer text: the public footer, plus the HOOK-DOC-01 footer when a theme supplies another one. */
export function footerText(theme: DocTheme): string {
  const f = theme.footer?.trim();
  return !f || f === DEFAULT_FOOTER ? DEFAULT_FOOTER : `${DEFAULT_FOOTER} · ${f}`;
}

/**
 * 07 §6.4 legend: one line per woven merge with the enhancement swatch, and a "Hide highlights"
 * toggle the runtime reveals (highlights stay visible without JS).
 */
function legendHtml(model: DocumentModel): string[] {
  const merges = model.merges ?? [];
  if (merges.length === 0) return [];
  return [
    `<div${attrs([
      ['class', 'enh-legend'],
      ['data-doc-id', model.docId],
    ])}>`,
    ...merges.map(
      (m) =>
        `<p${attrs([
          ['class', 'enh-legend-line'],
          ['data-merge', m.id],
        ])}><span class="enh-swatch" aria-hidden="true"></span>Enhanced on ${esc(formatDate(m.mergedAt))} with material from <cite>${esc(m.fromTitle)}</cite></p>`,
    ),
    '<button type="button" class="enh-toggle" aria-pressed="false" hidden>Hide highlights</button>',
    '</div>',
  ];
}

function headerHtml(model: DocumentModel, theme: DocTheme): string {
  const logo = theme.logoSvg ? `<span class="doc-logo">${theme.logoSvg}</span>` : '';
  return [
    '<header class="doc-head">',
    // Outside nav.tabbar: a tablist may own only tabs (13 §13 accessibility, axe aria-required-children).
    '<button type="button" class="theme-toggle" aria-label="Switch theme" hidden></button>',
    `<p class="kicker">${logo}Explainer</p>`,
    `<h1>${esc(model.title)}</h1>`,
    ...(model.dek ? [`<p class="dek">${esc(model.dek)}</p>`] : []),
    `<p class="doc-meta">${esc(metaLine(model))}</p>`,
    ...legendHtml(model),
    '</header>',
  ].join('\n');
}

/** The exact bytes of one `<section>` as they appear in the rendered page (for splicing, 08 §6.4). */
export function renderSectionHtml(
  model: DocumentModel,
  sectionId: string,
  assets: ReadonlyMap<string, Uint8Array>,
): string {
  const c = ctxOf(model, assets);
  for (const tab of model.tabs) {
    const s = tab.sections.find((x) => x.id === sectionId);
    if (s) return sectionHtml(c, tab, s);
  }
  throw new Error(`Unknown section ${sectionId}`);
}

/** The `#eli5-model` script body. */
export function modelJson(model: DocumentModel): string {
  return scriptSafeJson(canonicalJson(model));
}

/** Renders the document with an explicit runtime (07 §5.5). */
export function renderWithRuntime(
  model: DocumentModel,
  assets: ReadonlyMap<string, Uint8Array>,
  runtime: DocRuntime,
  theme: DocTheme = defaultDocTheme,
): string {
  const c = ctxOf(model, assets);
  const js = scriptSafe(runtime.js);
  const g = model.generator;
  const tabs = model.tabs;
  return [
    '<!doctype html>',
    '<html lang="en" data-eli5-format="1" data-theme="auto">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${esc(documentCsp(js))}">`,
    '<meta name="referrer" content="no-referrer">',
    `<meta${attrs([
      ['name', 'generator'],
      ['content', `${g.app} ${g.version} (${g.edition}); runtime ${g.runtimeVersion}`],
    ])}>`,
    `<title>${esc(model.title)}</title>`,
    `<style id="eli5-css">${styleSafe(runtime.css)}</style>`,
    `<style id="eli5-theme">${styleSafe(themeCss(theme))}</style>`,
    `<script type="application/json" id="eli5-model">${modelJson(model)}</script>`,
    '</head>',
    '<body>',
    headerHtml(model, theme),
    '<nav class="tabbar" role="tablist" aria-label="Document views">',
    ...tabs.map((t, i) => tabButton(t, i === 0)),
    '</nav>',
    '<main>',
    ...tabs.map((t) => panelHtml(c, t)),
    '</main>',
    `<footer class="doc-foot">${esc(footerText(theme))}</footer>`,
    `<script id="eli5-runtime">${js}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export type { RenderOptions };
