import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  INSTALL_ARTIFACT_PATHS,
  preflightReleaseArtifacts
} from '../src/bootstrap.mjs';

test('artifact preflight materializes the complete release and always removes its temporary directory', async () => {
  const calls = [];
  const result = await preflightReleaseArtifacts(
    { sourceRevision: 'a'.repeat(40) },
    {
      storageClass: 'hostpath',
      consoleUrl: 'https://localhost:8090',
      authEnvironment: 'development'
    },
    {
      async createTemporaryDirectory() {
        calls.push(['create']);
        return 'temporary-artifact-root';
      },
      async prepare(lock, root, storageClass, consoleUrl, authEnvironment) {
        calls.push(['prepare', lock.sourceRevision, root, storageClass, consoleUrl, authEnvironment]);
        return { all: [{ path: 'one' }, { path: 'two' }] };
      },
      async removeDirectory(root) {
        calls.push(['remove', root]);
      }
    }
  );
  assert.equal(result.artifactCount, INSTALL_ARTIFACT_PATHS.length);
  assert.equal(result.manifestGroupCount, 2);
  assert.deepEqual(calls.map(([operation]) => operation), ['create', 'prepare', 'remove']);
});

test('bootstrap downloads every release artifact before creating a namespace or installation state', async () => {
  const source = await readFile(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const bootstrapStart = source.indexOf('export async function bootstrap');
  const artifactPreparation = source.indexOf('const prepared = await prepareRelease', bootstrapStart);
  const namespaceMutation = source.indexOf('ensureNamespace(namespace)', bootstrapStart);
  const stateMutation = source.indexOf('recordInstallationState(', bootstrapStart);
  assert.ok(artifactPreparation > bootstrapStart);
  assert.ok(artifactPreparation < namespaceMutation);
  assert.ok(artifactPreparation < stateMutation);
});

test('doctor invokes the same complete artifact preflight before reporting success', async () => {
  const source = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  const doctorStart = source.indexOf("if (command === 'doctor')");
  const artifactPreflight = source.indexOf('await preflightReleaseArtifacts', doctorStart);
  const doctorFinish = source.indexOf("progress.finish('설치 전 진단 통과'", doctorStart);
  assert.ok(artifactPreflight > doctorStart);
  assert.ok(artifactPreflight < doctorFinish);
});
