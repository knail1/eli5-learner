// Stock photo attribution (07 §7.4): the caption credit and the "Image credits" references entry.
import { attrs, esc } from '../html';
import type { AssetCredit } from '../types';

/** Short license name as the license deed writes it, e.g. "CC BY-SA 4.0". */
export function licenseName(c: Pick<AssetCredit, 'license' | 'licenseVersion'>): string {
  const v = c.licenseVersion ? ` ${c.licenseVersion}` : '';
  switch (c.license) {
    case 'cc0':
      return `CC0${v || ' 1.0'}`;
    case 'pdm':
      return `Public Domain Mark${v || ' 1.0'}`;
    case 'by':
      return `CC BY${v}`;
    case 'by-sa':
      return `CC BY-SA${v}`;
  }
}

function httpHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function link(href: string | undefined, text: string, cls: string): string {
  const h = httpHref(href);
  if (!h) return `<span class="${cls}">${esc(text)}</span>`;
  return `<a${attrs([
    ['class', cls],
    ['href', h],
    ['target', '_blank'],
    ['rel', 'noopener noreferrer'],
  ])}>${esc(text)}</a>`;
}

/**
 * Title, creator, source and license (the attribution CC BY and BY-SA require), marked as an
 * illustrative stock photo so no pictured person is read as part of the story. The image is
 * resized and re-encoded, which the credit says.
 */
export function creditHtml(c: AssetCredit): string {
  const by = c.creator ? ` by ${esc(c.creator)}` : '';
  const via = c.via && c.via !== c.sourceName ? ` via ${esc(c.via)}` : '';
  return (
    'Illustrative stock photo: ' +
    `<cite>${esc(c.title)}</cite>${by}, ` +
    `${link(c.licenseUrl, licenseName(c), 'fig-license')}, ` +
    `from ${link(c.sourceUrl, c.sourceName, 'fig-source')}${via}. Resized.`
  );
}
