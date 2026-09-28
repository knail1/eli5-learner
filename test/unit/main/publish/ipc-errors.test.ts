import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { toIpcError } = await import('../../../../src/main/ipc/handle');
const { PublishRequestError } = await import('../../../../src/main/publish');

/** The publish service's refusals reach the renderer with their own IpcErrorCode (10 §4, §7). */
describe('PublishRequestError at the IPC boundary', () => {
  it.each([
    ['E_NOT_FOUND', 'Publish target not found'],
    ['E_CONFLICT', 'Already publishing'],
    ['E_FORBIDDEN', 'That link cannot be opened'],
    ['E_RATE_LIMITED', 'Link not opened'],
    ['E_IO', 'The exported copy could not be opened'],
  ] as const)('%s keeps its code and message', (code, message) => {
    expect(toIpcError(new PublishRequestError(code, message))).toEqual({ code, message });
  });
});
