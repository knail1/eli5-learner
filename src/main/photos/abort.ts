/** The AbortError photos code rethrows on cancellation (same shape as the fetch module's, 05 §2). */
export function abortError(): DOMException {
  return new DOMException('The photo search was aborted', 'AbortError');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
