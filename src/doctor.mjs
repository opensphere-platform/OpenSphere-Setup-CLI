import { spawnSync } from 'node:child_process';
import net from 'node:net';

const REQUIRED_NODE_MAJOR = 24;
const SUPPORTED_SETUP_HOSTS = new Set([
  'win32/x64',
  'linux/x64',
  'linux/arm64',
  'darwin/x64',
  'darwin/arm64'
]);

function firstLine(value) {
  return String(value ?? '').trim().split(/\r?\n/, 1)[0];
}

export function inspectCommand(command, args, {
  spawn = spawnSync,
  env = process.env
} = {}) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error(`Required command is not installed or is not on PATH: ${command}`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = firstLine(result.stderr || result.stdout);
    throw new Error(`Required command failed: ${command}${detail ? ` (${detail})` : ''}`);
  }
  return firstLine(result.stdout || result.stderr) || 'available';
}

export function inspectLocalEnvironment({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  inspect = inspectCommand,
  requireGh = true
} = {}) {
  const host = `${platform}/${arch}`;
  if (!SUPPORTED_SETUP_HOSTS.has(host)) {
    throw new Error(`Unsupported Setup host platform: ${host}`);
  }
  const nodeMajor = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < REQUIRED_NODE_MAJOR) {
    throw new Error(`OpenSphere Setup requires Node.js ${REQUIRED_NODE_MAJOR} or newer; found ${nodeVersion}`);
  }
  const tools = {
    kubectl: inspect('kubectl', ['version', '--client', '-o', 'json']),
    pwsh: inspect('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
  };
  if (requireGh) tools.gh = inspect('gh', ['--version']);
  return { host, node: `v${nodeVersion}`, tools };
}

export function formatLocalEnvironment(evidence) {
  return `${evidence.host}, Node ${evidence.node}, ${Object.keys(evidence.tools).join('/')} 확인`;
}

export async function assertFreshConsolePortAvailable(consoleUrl, {
  createServer = () => net.createServer()
} = {}) {
  const url = new URL(consoleUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return { checked: false, origin: url.origin };
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname === '[::1]' ? '::1' : '127.0.0.1';
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      reject(new Error(`Console port is unavailable for a fresh install: ${host}:${port} (${error.code ?? error.message})`));
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  return { checked: true, host, port, origin: url.origin };
}

export const DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB = 98;
