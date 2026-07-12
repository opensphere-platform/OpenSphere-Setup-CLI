import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../src/http.mjs';

test('HTTP helper retries transient server failures', async () => {
  let calls = 0;
  const response = await fetchWithRetry('https://example.invalid', {}, {
    attempts: 3,
    baseDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: calls < 3 ? 503 : 200 });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test('HTTP helper does not retry permanent client failures', async () => {
  let calls = 0;
  const response = await fetchWithRetry('https://example.invalid', {}, {
    attempts: 4,
    baseDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 404 });
    }
  });
  assert.equal(response.status, 404);
  assert.equal(calls, 1);
});

test('HTTP helper retries network errors and eventually returns', async () => {
  let calls = 0;
  const response = await fetchWithRetry('https://example.invalid', {}, {
    attempts: 2,
    baseDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary network failure');
      return new Response('', { status: 200 });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});
