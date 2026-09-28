/** Content Security Policies delivered as response headers (12 §7.4). */

export const APP_CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

/** Dev adds the Vite dev server; selected only when !app.isPackaged. */
export const APP_CSP_DEV = APP_CSP_PROD.replace(
  "script-src 'self'",
  "script-src 'self' http://localhost:* 'unsafe-inline'",
).replace("connect-src 'self'", "connect-src 'self' http://localhost:* ws://localhost:*");

export const VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
