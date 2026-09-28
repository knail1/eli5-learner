import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { z } from 'zod';
import type { IpcChannel, IpcError, IpcErrorCode, IpcResult, IpcSurface } from '../../preload/contract';
import { NotAvailableInEdition } from '../editions';
import { SettingsError } from '../config';
import { KeychainUnavailable } from '../config';
import { LibraryError, type LibraryErrorCode } from '../library';
import { LLMError } from '../llm';
import { PipelineRequestError } from '../pipeline';
import { PublishError, PublishRequestError } from '../publish';
import { log } from '../security';
import { InvalidDraftId } from '../sources';

/** Identity of the two renderer surfaces allowed to invoke (12 §7.2 step 6). */
export interface SenderIdentity {
  appWebContents(): WebContents | undefined;
  viewerWebContents(): WebContents | undefined;
  /** App renderer origin: the dev server URL origin or the packaged file/app URL scheme. */
  isAppUrl(url: URL): boolean;
}

/** Error thrown by handlers to return a specific IpcError. */
export class IpcFailure extends Error {
  constructor(readonly error: IpcError) {
    super(error.message);
    this.name = 'IpcFailure';
  }
}

/** Return value that succeeds but carries non-fatal warnings (IpcResult.warnings). */
export class WithWarnings<T> {
  constructor(
    readonly value: T,
    readonly warnings: string[],
  ) {}
}

export function fail(code: IpcErrorCode, message: string, extra: Partial<IpcError> = {}): never {
  throw new IpcFailure({ code, message, ...extra });
}

/** Checks identity first and URL last; returns false on any mismatch. */
export function assertSender(event: IpcMainInvokeEvent, surface: IpcSurface, ids: SenderIdentity): boolean {
  const expected = surface === 'viewer' ? ids.viewerWebContents() : ids.appWebContents();
  if (!expected || event.sender.id !== expected.id) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  let url: URL;
  try {
    url = new URL(frame.url);
  } catch {
    return false;
  }
  if (surface === 'viewer') return url.protocol === 'eli5doc:' && url.hostname === 'doc';
  return ids.isAppUrl(url);
}

/** Maps any thrown value to an IpcError; never leaks messages from unknown errors. */
export function toIpcError(err: unknown): IpcError {
  if (err instanceof IpcFailure) return err.error;
  if (err instanceof NotAvailableInEdition) {
    return {
      code: 'E_NOT_AVAILABLE_IN_EDITION',
      message: 'Not available in this edition',
      capability: err.capability,
      hookId: err.hookId,
    };
  }
  if (err instanceof SettingsError) return { code: err.code, message: err.message, issues: err.issues };
  if (err instanceof KeychainUnavailable) return { code: 'E_KEYCHAIN_UNAVAILABLE', message: err.message };
  if (err instanceof PipelineRequestError) return { code: err.code, message: err.message };
  if (err instanceof LibraryError) return libraryError(err.code);
  if (err instanceof PublishRequestError) return { code: err.code, message: err.message };
  // 01 §5.1, 10 §11: one boundary code; the PublishErrorCode travels in detailCode, `detail` never.
  if (err instanceof PublishError) {
    return {
      code: 'E_PUBLISH_FAILED',
      message: err.message,
      detailCode: err.code,
      ...(err.findings ? { findings: err.findings } : {}),
    };
  }
  if (err instanceof InvalidDraftId) return { code: 'E_BAD_REQUEST', message: 'Invalid request' };
  // 01 §6.2: a provider that finds no key at call time maps to E_NO_API_KEY.
  if (err instanceof LLMError && err.kind === 'auth') return NO_API_KEY;
  return { code: 'E_INTERNAL', message: 'Something went wrong' };
}

export const NO_API_KEY: IpcError = { code: 'E_NO_API_KEY', message: 'Add an API key in Settings' };

/** 01 §5.1: LibraryError codes at the boundary; the module's detail is never sent. */
function libraryError(code: LibraryErrorCode): IpcError {
  switch (code) {
    case 'LIBRARY_READ_ONLY':
      return { code: 'E_LIBRARY_READ_ONLY', message: 'The Library is read-only' };
    case 'SUGGESTION_STALE':
      return { code: 'E_SUGGESTION_STALE', message: 'That suggestion is out of date' };
    case 'MERGE_FAILED':
      return { code: 'E_MERGE_FAILED', message: 'The documents could not be merged' };
    case 'NOT_FOUND':
      return { code: 'E_NOT_FOUND', message: 'Document not found' };
    case 'HISTORY_EMPTY':
      return { code: 'E_CONFLICT', message: 'Nothing to undo or redo' };
    case 'FOLDER_NOT_FOUND':
      return { code: 'E_NOT_FOUND', message: 'Folder not found' };
    case 'FOLDER_NAME_INVALID':
      return { code: 'E_BAD_REQUEST', message: 'Folder names are 1 to 60 characters and not "Archive" or "Trash"' };
    case 'FOLDER_NAME_TAKEN':
      return { code: 'E_CONFLICT', message: 'A folder with that name already exists' };
    case 'TRASH_ITEM_NOT_FOUND':
      return { code: 'E_NOT_FOUND', message: 'That document is no longer in the Trash' };
    default:
      return { code: 'E_IO', message: 'Could not access the Library' };
  }
}

export interface HandlerRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
}

export type Handler<S extends z.ZodType, R> = (payload: z.infer<S>, event: IpcMainInvokeEvent) => Promise<R> | R;

/**
 * Registers one invoke channel: sender check, zod validation, IpcResult envelope (01 §5.1).
 * Handlers never throw across the boundary.
 */
export function makeHandle(ipc: HandlerRegistrar, ids: SenderIdentity) {
  return function handle<S extends z.ZodType, R>(
    channel: IpcChannel,
    surface: IpcSurface,
    schema: S,
    fn: Handler<S, R>,
  ): void {
    ipc.handle(channel, async (event, payload): Promise<IpcResult<R>> => {
      if (!assertSender(event, surface, ids)) {
        log.warn('ipc.rejected-sender', { channel });
        return { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        log.warn('ipc.bad-request', { channel });
        return {
          ok: false,
          error: {
            code: 'E_BAD_REQUEST',
            message: 'Invalid request',
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        };
      }
      try {
        const value = await fn(parsed.data, event);
        if (value instanceof WithWarnings) return { ok: true, value: value.value as R, warnings: value.warnings };
        return { ok: true, value };
      } catch (err) {
        const error = toIpcError(err);
        if (error.code === 'E_INTERNAL') log.error('ipc.handler-failed', { channel }, err);
        else log.info('ipc.handler-error', { channel, code: error.code });
        return { ok: false, error };
      }
    });
  };
}

/** Payload schema for channels that take no arguments. */
export const NoPayload = z.undefined().or(z.null()).optional();

/** Registers one channel on the surface 01 §5.2 assigns it; used by the per-area handler files. */
export type Register = <S extends z.ZodType, R>(
  channel: IpcChannel,
  schema: S,
  fn: (payload: z.infer<S>, event: IpcMainInvokeEvent) => Promise<R> | R,
) => void;
