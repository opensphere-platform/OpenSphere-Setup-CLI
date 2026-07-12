import { spawnSync } from 'node:child_process';

export function run(command, args, options = {}) {
  const capture = Boolean(options.capture);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] : 'inherit',
    input: options.input,
    windowsHide: true,
    ...options.spawn
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${detail}`);
  }
  return capture ? result.stdout.trim() : '';
}

export function kubectl(args, options) {
  const context = process.env.OPENSPHERE_KUBE_CONTEXT;
  return run('kubectl', context ? ['--context', context, ...args] : args, options);
}

export function assertKubectl() {
  const client = kubectl(['version', '--client', '-o', 'json'], { capture: true });
  const cluster = kubectl(['version', '-o', 'json'], { capture: true });
  return { client: JSON.parse(client), cluster: JSON.parse(cluster) };
}
