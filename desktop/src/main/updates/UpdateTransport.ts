/** Abort must settle the caller even when a transport or stream ignores it.
 * Cleanup is best effort and never extends the request deadline. */
export function updateTransport(signal: AbortSignal) {
  let reject!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, fail) => { reject = fail; });
  void interrupted.catch(() => undefined);
  const abort = () => reject(new Error('Update request interrupted.'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const discard = (body: { cancel(): Promise<unknown> } | null | undefined) => {
    try { void body?.cancel().catch(() => undefined); } catch { /* locked/closed */ }
  };
  return {
    wait: <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, interrupted]),
    request: async (pending: Promise<Response>): Promise<Response> => {
      void pending.then(response => { if (signal.aborted) discard(response.body); }, () => undefined);
      return Promise.race([pending, interrupted]);
    },
    discard,
    dispose: () => signal.removeEventListener('abort', abort),
  };
}
