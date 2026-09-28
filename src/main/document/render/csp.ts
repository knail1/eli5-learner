// Document Content Security Policy (07 §6.2): hash-based script-src for the inlined runtime.
import { createHash } from 'node:crypto';

/** CSP source expression for an inline script body, hashed exactly as emitted. */
export function scriptHash(js: string): string {
  return `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`;
}

/** The meta CSP of every document (07 §6.2). */
export function documentCsp(runtimeJs: string): string {
  return [
    "default-src 'none'",
    'img-src data:',
    "style-src 'unsafe-inline'",
    'font-src data:',
    `script-src ${scriptHash(runtimeJs)}`,
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}
