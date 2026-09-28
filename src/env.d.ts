/** Build-time constants (01 §8.1). Defined by electron.vite.config.ts and vitest.config.ts. */
declare const __ELI5_EDITION__: 'public' | 'enterprise';
declare const __ELI5_TEST__: boolean;

declare module '*?raw' {
  const content: string;
  export default content;
}
