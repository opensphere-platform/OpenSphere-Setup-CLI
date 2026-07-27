import { spawnSync } from 'node:child_process';

// spawnSync의 maxBuffer 기본값은 1MB다. upgrade 트랜잭션은 전체 release manifest를
// 한 번에 apply하고 그 출력을 캡처하므로 이 한계를 넘기면 ENOBUFS로 죽는다. 더 나쁜 것은
// 같은 한계가 rollback 경로에도 걸려 "upgrade 실패 + rollback 실패"로 클러스터를 중간
// 상태에 남길 수 있다는 점이다. 버퍼 한계가 트랜잭션 안전성을 좌우해서는 안 된다.
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;

export function run(command, args, options = {}) {
  const capture = Boolean(options.capture);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] : 'inherit',
    input: options.input,
    windowsHide: true,
    maxBuffer: MAX_BUFFER_BYTES,
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
