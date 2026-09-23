type CompletionResponse = { status: number; error?: string };

const DEFAULT_RETRY_DELAYS_MS = [350, 700, 1400];

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Retry the idempotent local-clip completion acknowledgement after a transient failure. */
export async function completeLocalClipTaskWithRetry({
  complete,
  wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: {
  complete: () => Promise<CompletionResponse>;
  wait?: (milliseconds: number) => Promise<unknown>;
}) {
  let lastError: Error = new Error("剪藏任务确认失败");
  for (let attempt = 0; attempt <= DEFAULT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await complete();
      if (response.status === 200) return;
      lastError = new Error(response.error || `剪藏任务确认失败（HTTP ${response.status}）`);
      if (!isRetryableStatus(response.status)) throw lastError;
    } catch (error) {
      if (error === lastError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    const delay = DEFAULT_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await wait(delay);
  }
  throw lastError;
}
