import { spawn } from 'node:child_process';
import net from 'node:net';

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

export function portForwardArgs({ namespace, service, localPort, remotePort, context = process.env.OPENSPHERE_KUBE_CONTEXT }) {
  if (!namespace || !service || !Number.isInteger(localPort) || !Number.isInteger(remotePort)) {
    throw new Error('Port-forward requires namespace, service, localPort and remotePort');
  }
  return [
    ...(context ? ['--context', context] : []),
    '-n', namespace,
    'port-forward', `svc/${service}`, `${localPort}:${remotePort}`,
    '--address', '127.0.0.1'
  ];
}

export function waitForPortForward(process, label, timeoutMs = 30_000) {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      process.stdout?.off('data', inspect);
      process.stderr?.off('data', inspect);
      process.off('error', onError);
      process.off('exit', onExit);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const inspect = (chunk) => {
      if (String(chunk).includes('Forwarding from')) settle(resolveReady);
    };
    const onError = (error) => settle(reject, error);
    const onExit = (code, signal) => settle(reject, new Error(`${label} verification tunnel exited before ready (${code ?? signal ?? 'unknown'})`));
    const timer = setTimeout(() => settle(reject, new Error(`${label} verification tunnel timed out`)), timeoutMs);
    process.stdout?.on('data', inspect);
    process.stderr?.on('data', inspect);
    process.once('error', onError);
    process.once('exit', onExit);
  });
}

// The configured public Console origin is still embedded into OIDC and the
// release manifest. This local transport exists so a clean installation can
// download its Console-owned CLI before external ingress/DNS is ready.
export async function withServicePortForward({
  namespace,
  service,
  remotePort,
  label = service,
  protocol = 'https',
  context = process.env.OPENSPHERE_KUBE_CONTEXT
}, operation, {
  spawnProcess = spawn,
  allocatePort = freePort,
  waitForReady = waitForPortForward
} = {}) {
  if (typeof operation !== 'function') throw new Error('Port-forward operation is required');
  const localPort = await allocatePort();
  const forward = spawnProcess('kubectl', portForwardArgs({ namespace, service, localPort, remotePort, context }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  try {
    await waitForReady(forward, label);
    return await operation(`${protocol}://localhost:${localPort}`);
  } finally {
    forward.kill();
  }
}
