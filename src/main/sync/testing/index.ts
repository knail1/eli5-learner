// Test-only entry (13 §6.1): the e2e fakes for personal sync, imported by bootstrap only in test
// builds with ELI5_SYNC_FAKE=1. Package builds never contain it.
export { MemorySyncStore } from './memory-store';
export { fakeGoogle, FAKE_ACCOUNT } from './fake-google';
export type { FakeGoogle } from './fake-google';
