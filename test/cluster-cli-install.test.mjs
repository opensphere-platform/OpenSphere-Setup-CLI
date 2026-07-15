import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installConsoleCliFromCluster } from '../src/cluster-cli-install.mjs';
import { portForwardArgs, withServicePortForward } from '../src/port-forward.mjs';

test('bootstrap artifact transport uses a local Console Service tunnel, not the configured public origin', async () => {
  let tunnelOptions;
  let installOptions;
  const result = await installConsoleCliFromCluster({ installDirectory: '/tmp/os', updatePath: true }, {
    tunnel: async (options, operation) => {
      tunnelOptions = options;
      return operation('https://localhost:49152');
    },
    install: async (options) => {
      installOptions = options;
      return { version: '0.4.0', target: '/tmp/os/os' };
    }
  });
  assert.deepEqual(tunnelOptions, {
    namespace: 'opensphere-console', service: 'opensphere-console-ext', remotePort: 8090, label: 'Console artifact download', protocol: 'https'
  });
  assert.deepEqual(installOptions, {
    consoleUrl: 'https://localhost:49152', installDirectory: '/tmp/os', insecureSkipTlsVerify: true, updatePath: true
  });
  assert.equal(result.version, '0.4.0');
});

test('edge loopback HTTP keeps CLI artifact transport on the configured service protocol', async () => {
  let tunnelOptions;
  let installOptions;
  await installConsoleCliFromCluster({ consoleUrl: 'http://localhost:8090' }, {
    tunnel: async (options, operation) => {
      tunnelOptions = options;
      return operation('http://localhost:49154');
    },
    install: async (options) => {
      installOptions = options;
      return { version: '0.4.0', target: '/tmp/os/os' };
    }
  });
  assert.equal(tunnelOptions.protocol, 'http');
  assert.equal(installOptions.consoleUrl, 'http://localhost:49154');
  assert.equal(installOptions.insecureSkipTlsVerify, false);
});

test('service port-forward binds loopback and honors the selected Kubernetes context', () => {
  assert.deepEqual(portForwardArgs({
    namespace: 'opensphere-console', service: 'opensphere-console-ext', localPort: 49152, remotePort: 8090, context: 'audit-kind'
  }), ['--context', 'audit-kind', '-n', 'opensphere-console', 'port-forward', 'svc/opensphere-console-ext', '49152:8090', '--address', '127.0.0.1']);
});

test('service port-forward passes a local HTTPS origin to its operation and always terminates the child', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; };
  let command;
  let args;
  const result = await withServicePortForward({ namespace: 'n', service: 's', remotePort: 443, label: 'test', context: 'ctx' }, async (origin) => origin, {
    allocatePort: async () => 49153,
    spawnProcess: (nextCommand, nextArgs) => {
      command = nextCommand;
      args = nextArgs;
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('Forwarding from 127.0.0.1:49153')));
      return child;
    }
  });
  assert.equal(command, 'kubectl');
  assert.deepEqual(args, ['--context', 'ctx', '-n', 'n', 'port-forward', 'svc/s', '49153:443', '--address', '127.0.0.1']);
  assert.equal(result, 'https://localhost:49153');
  assert.equal(killed, true);
});
