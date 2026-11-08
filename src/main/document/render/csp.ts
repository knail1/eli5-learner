// Document Content Security Policy (07 §6.2): hash-based script-src for the inlined runtime.
import { createHash } from 'node:crypto';

/** CSP source expression for an inline script body, hashed exactly as emitted. */
export function scriptHash(js: string): string {
  return `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`;
}

/**
 * The meta CSP of every document (07 §6.2). `frameHashes` are the script hashes of the document's
 * animation frames (07 §7.1): an `about:srcdoc` document inherits this policy in every engine, so
 * its two scripts must be admitted here as well as by the frame's own policy. Without animations
 * the policy is byte-identical to the one older documents carry.
 */
export function documentCsp(runtimeJs: string, frameHashes: readonly string[] = []): string {
  return [
    "default-src 'none'",
    'img-src data:',
    "style-src 'unsafe-inline'",
    'font-src data:',
    `script-src ${[scriptHash(runtimeJs), ...frameHashes].join(' ')}`,
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}
