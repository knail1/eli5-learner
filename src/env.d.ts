/** Build-time constants (01 §8.1). Defined by config/electron.vite.config.ts and config/vitest.config.ts. */
declare const __ELI5_EDITION__: 'public' | 'enterprise';
declare const __ELI5_TEST__: boolean;

declare module '*?raw' {
  const content: string;
  export default content;
}
