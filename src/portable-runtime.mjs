import { existsSync } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';

/**
 * Portable release archives carry pwsh and kubectl beside the SEA executable.
 * Source/npm installs intentionally keep using the operator PATH.
 */
export function activatePortableRuntime({
  executable = process.execPath,
  environment = process.env,
  platform = process.platform
} = {}) {
  const root = environment.OPENSPHERE_PORTABLE_ROOT
    ? resolve(environment.OPENSPHERE_PORTABLE_ROOT)
    : dirname(executable);
  const pwsh = join(root, 'runtime', 'pwsh');
  const bin = join(root, 'runtime', 'bin');
  const expected = [
    join(pwsh, platform === 'win32' ? 'pwsh.exe' : 'pwsh'),
    join(bin, platform === 'win32' ? 'kubectl.exe' : 'kubectl')
  ];
  if (!expected.every(existsSync)) return { active: false, root };
  environment.PATH = [pwsh, bin, environment.PATH ?? ''].filter(Boolean).join(delimiter);
  environment.OPENSPHERE_BUNDLED_RUNTIME = '1';
  return { active: true, root, pwsh: expected[0], kubectl: expected[1] };
}

export const portableRuntime = activatePortableRuntime();
