/**
 * Append one asynchronous input operation to a queue that always remains
 * usable after an operation or diagnostic callback fails.
 */
export function enqueueSerialInput(
  pending: Promise<void>,
  operation: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const reportError = (error: unknown): void => {
    try {
      onError(error);
    } catch {
      // Diagnostics must not poison the queue or skip later input frames.
    }
  };
  return pending.catch(reportError).then(operation).catch(reportError);
}
