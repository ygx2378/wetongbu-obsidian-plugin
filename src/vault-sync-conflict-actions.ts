export type ConflictFollowUpScheduler = (callback: () => void) => unknown;

/**
 * Keep a successful, durable conflict choice separate from the next sync pass.
 * A later editor-busy defer must not make the conflict action look unsuccessful.
 */
export async function resolveConflictAndScheduleFollowUp<T>(
  resolve: () => Promise<T>,
  followUp: () => Promise<unknown>,
  onFollowUpError: (error: unknown) => void,
  schedule: ConflictFollowUpScheduler = (callback) => globalThis.setTimeout(callback, 0),
): Promise<T> {
  const result = await resolve();
  const report = (error: unknown) => {
    try {
      onFollowUpError(error);
    } catch {
      // Reporting a follow-up error cannot reverse the already durable choice.
    }
  };

  try {
    schedule(() => {
      void Promise.resolve().then(followUp).catch(report);
    });
  } catch (error) {
    report(error);
  }
  return result;
}
