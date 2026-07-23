import { getAsset, isSea } from 'node:sea';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve a Setup runtime asset from the installed package, or materialize it
 * from a Node SEA executable. Assets contain no credentials and are removed
 * immediately after the caller finishes using them.
 */
export async function materializeRuntimeAsset(name, packageDirectory) {
  if (!isSea()) {
    return {
      path: join(packageDirectory, name),
      cleanup: async () => {}
    };
  }

  const directory = await mkdtemp(join(tmpdir(), 'opensphere-setup-asset-'));
  const path = join(directory, name);
  await writeFile(path, getAsset(name, 'utf8'), { encoding: 'utf8', mode: 0o600 });
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
