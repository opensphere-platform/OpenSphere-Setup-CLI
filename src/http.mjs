const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchWithRetry(url, options = {}, {
  fetchImpl = fetch,
  attempts = 4,
  timeoutMs = 20_000,
  baseDelayMs = 500
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(timeoutMs)
      });
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) return response;
      lastError = new Error(`${url} returned retryable HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await delay(baseDelayMs * (2 ** (attempt - 1)));
  }
  throw lastError;
}
