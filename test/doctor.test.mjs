import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB,
  assertFreshConsolePortAvailable,
  formatLocalEnvironment,
  inspectLocalEnvironment
} from '../src/doctor.mjs';

test('doctor validates all commands required before bootstrap mutates Kubernetes', () => {
  const calls = [];
  const evidence = inspectLocalEnvironment({
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: '24.4.0',
    inspect(command, args) {
      calls.push([command, args]);
      return `${command}-version`;
    }
  });
  assert.deepEqual(calls.map(([command]) => command), ['kubectl', 'pwsh', 'gh']);
  assert.match(formatLocalEnvironment(evidence), /darwin\/arm64/);
  assert.equal(DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB, 88);
});

test('doctor checks the fresh loopback Console port and skips remote origins', async () => {
  let listened;
  const createServer = () => ({
    unref() {},
    once() {},
    listen(options, callback) {
      listened = options;
      callback();
    },
    close(callback) { callback(); }
  });
  const local = await assertFreshConsolePortAvailable('https://localhost:8090', { createServer });
  assert.deepEqual(listened, { host: '127.0.0.1', port: 8090, exclusive: true });
  assert.equal(local.checked, true);
  const remote = await assertFreshConsolePortAvailable('https://console.example.test', { createServer });
  assert.equal(remote.checked, false);
});

test('doctor rejects unsupported host and old source-install Node before tool execution', () => {
  assert.throws(
    () => inspectLocalEnvironment({ platform: 'freebsd', arch: 'x64', inspect() {} }),
    /Unsupported Setup host platform/
  );
  assert.throws(
    () => inspectLocalEnvironment({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '22.0.0',
      inspect() { throw new Error('must not run'); }
    }),
    /Node\.js 24 or newer/
  );
});
