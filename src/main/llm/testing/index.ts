// Test-only entry (13 §6.1): the fixture overlay reaches FakeProvider as `@eli5/public/llm/testing`
// (01 §6.5). Nothing in the app imports this file, so package builds never contain it.
export { FakeProvider, loadFakeScript } from './fake';
export type { FakeCall, FakeProviderOptions, FakeResponse, FakeScript } from './fake';
