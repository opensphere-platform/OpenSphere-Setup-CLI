import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForJobCompletion } from '../src/bootstrap.mjs';

function jobWith(type, reason = undefined, message = undefined) {
  return JSON.stringify({
    status: type ? { conditions: [{ type, status: 'True', reason, message }] } : {}
  });
}

test('waitForJobCompletion returns on Complete', () => {
  const calls = [];
  const result = waitForJobCompletion('ns', 'backup', {
    kubectlFn: (args) => { calls.push(args); return jobWith('Complete'); },
    now: () => 0,
    sleep: () => assert.fail('complete Job must not sleep')
  });
  assert.equal(result.status.conditions[0].type, 'Complete');
  assert.equal(calls.length, 1);
});

test('waitForJobCompletion fails immediately on Failed and includes pod logs', () => {
  let getCalls = 0;
  const kubectlFn = (args) => {
    if (args.includes('logs')) return 'restore: sealed bootstrap credential rejected';
    getCalls += 1;
    return jobWith('Failed', 'BackoffLimitExceeded', 'Job has reached the specified backoff limit');
  };
  assert.throws(
    () => waitForJobCompletion('opensphere-console-data', 'restore', {
      kubectlFn,
      now: () => 0,
      sleep: () => assert.fail('failed Job must not sleep')
    }),
    /BackoffLimitExceeded[\s\S]*sealed bootstrap credential rejected/
  );
  assert.equal(getCalls, 1);
});

test('waitForJobCompletion polls non-terminal Jobs and enforces its deadline', () => {
  let clock = 0;
  let sleeps = 0;
  assert.throws(
    () => waitForJobCompletion('ns', 'pending', {
      timeoutMs: 4_000,
      intervalMs: 2_000,
      kubectlFn: () => jobWith(null),
      now: () => clock,
      sleep: (milliseconds) => { sleeps += 1; clock += milliseconds; }
    }),
    /did not complete within 4s/
  );
  assert.equal(sleeps, 2);
});
