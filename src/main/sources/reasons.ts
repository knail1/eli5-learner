/** Skip reasons (03 §9) and the McpError -> SkipCode mapping (03 §10.1 rule 2). */
import type { McpError, SkipCode, SkippedSource } from './types';

/**
 * Base reason text per code (03 §9). Fetch (05 §10) and extraction (04 §8.2) rows are fallbacks,
 * used only when such a code is raised outside its owner.
 */
export const SKIP_REASONS: Readonly<Record<SkipCode, string>> = Object.freeze({
  'not-found': 'File not found.',
  'permission-denied': 'macOS did not allow the app to read this file.',
  'not-a-regular-file': 'Not a regular file.',
  empty: 'File was empty.',
  'file-changed': 'File changed or moved.',
  'unsupported-type': 'Unsupported file type.',
  'legacy-office-format': 'Older Office format; re-save as .pptx, .docx, or .xlsx.',
  'too-large': 'File is larger than the supported size.',
  'limit-exceeded': 'Too many sources in one job; this one was not used.',
  'not-a-url': 'Not a valid web address.',
  'unsupported-scheme': 'Only web addresses (http or https) are supported.',
  'not-available-in-edition': 'Requires the enterprise edition.',
  'sign-in-required': 'Sign in to the organization to include this source.',
  'access-denied': 'Your organization account does not have access to this source.',
  cancelled: 'Job was cancelled.',
  'read-error': 'Could not be read.',
  'fetch-failed': 'page could not be fetched',
  'login-required': 'page required login',
  paywall: 'page required a subscription',
  timeout: 'fetch timed out',
  'http-error': 'site returned an error',
  'empty-content': 'page had no readable content',
  'render-failed': 'page could not be rendered',
  'blocked-private-address': 'link redirected to a private network address',
  encrypted: 'File is password protected',
  corrupt: 'File could not be read (damaged or not a valid file)',
  'zip-bomb': 'File expands to an unsafe size',
  'image-too-large': 'Image too large to send',
  'image-budget-exceeded': 'Too many images in one job',
  'scan-render-failed': 'Scanned PDF pages could not be rendered',
  'internal-error': 'Unexpected error while reading this file',
});

const stripDot = (s: string) => s.replace(/\.\s*$/, '');

/** Base reason plus at most one short detail clause (03 §9). A detail equal to the base is dropped. */
export function skipReason(code: SkipCode, detail?: string): string {
  const base = SKIP_REASONS[code];
  const d = detail?.trim();
  if (!d || stripDot(d).toLowerCase() === stripDot(base).toLowerCase()) return base;
  return `${stripDot(base)}: ${stripDot(d)}.`;
}

export function skip(ref: string, code: SkipCode, detail?: string): SkippedSource {
  return { ref, code, reason: skipReason(code, detail) };
}

/** 03 §10.1 rule 2. */
export function mapMcpErrorKind(kind: McpError['kind']): SkipCode {
  switch (kind) {
    case 'auth-expired':
      return 'sign-in-required';
    case 'forbidden':
      return 'access-denied';
    case 'not-found':
      return 'not-found';
    case 'too-large':
      return 'too-large';
    case 'timeout':
      return 'timeout';
    case 'transport':
    case 'tool-error':
      return 'fetch-failed';
  }
}

/** Human reason for an organization URL that no resolver in this edition can serve (03 §8 step 3). */
export const ORG_SOURCE_DETAIL = 'Organization source; requires the enterprise edition';
