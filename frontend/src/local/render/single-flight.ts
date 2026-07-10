/**
 * Single-flight lock for heavyweight async operations.
 *
 * `createSingleFlight(message)` returns a runner: while one task is in
 * flight, any further call rejects immediately with `message` instead of
 * running concurrently. Used by the quick renderer to prevent two encodes
 * racing each other into the same OPFS output file (#91).
 */
export function createSingleFlight(
  errorMessage: string,
): <T>(task: () => Promise<T>) => Promise<T> {
  let inFlight = false;
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (inFlight) throw new Error(errorMessage);
    inFlight = true;
    try {
      return await task();
    } finally {
      inFlight = false;
    }
  };
}
