import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRecoveryManifestKey,
  recoveryDrillJob,
  startRecoveryDrill
} from '../src/recovery-drill.mjs';

const lock = {
  components: {
    recovery: { image: `ghcr.io/opensphere-platform/opensphere-console-recovery@sha256:${'a'.repeat(64)}` }
  }
};

test('isolated recovery drill is digest pinned, bounded and cannot accept a vault URL', () => {
  const job = recoveryDrillJob(lock, {
    component: 'supabase',
    manifestKey: 'opensphere-recovery/v1/20260724Z/supabase/manifest.json',
    id: 'A0B1-C2D3'
  });
  assert.equal(job.metadata.namespace, 'opensphere-console-recovery');
  assert.match(job.metadata.name, /^opensphere-recovery-drill-supabase-a0b1c2d3$/);
  const pod = job.spec.template.spec;
  assert.equal(pod.containers[0].image, lock.components.recovery.image);
  assert.equal(pod.containers[0].env.find(({ name }) => name === 'RECOVERY_MODE').value, 'drill-supabase');
  assert.equal(pod.containers[0].env.find(({ name }) => name === 'RECOVERY_MANIFEST_KEY').value, 'opensphere-recovery/v1/20260724Z/supabase/manifest.json');
  assert.equal(pod.volumes.find(({ name }) => name === 'target').secret.secretName, 'opensphere-platform-recovery-target');
  assert.equal(pod.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.throws(() => assertRecoveryManifestKey('https://s3.example.test/bucket/manifest.json'), /normalized S3 object key/);
  assert.throws(() => assertRecoveryManifestKey('opensphere-recovery/../manifest.json'), /normalized S3 object key/);
});

test('drill creates one isolated job and waits for its assertion result', () => {
  const calls = [];
  const result = startRecoveryDrill(lock, {
    component: 'gitea', manifestKey: 'opensphere-recovery/v1/run/gitea/manifest.json', id: 'aabbcc'
  }, {
    apply(job) { calls.push(['apply', job.metadata.namespace, job.metadata.name]); },
    wait(namespace, name, options) { calls.push(['wait', namespace, name, options.timeoutMs]); }
  });
  assert.deepEqual(result, { namespace: 'opensphere-console-recovery', name: 'opensphere-recovery-drill-gitea-aabbcc', component: 'gitea' });
  assert.deepEqual(calls, [
    ['apply', 'opensphere-console-recovery', 'opensphere-recovery-drill-gitea-aabbcc'],
    ['wait', 'opensphere-console-recovery', 'opensphere-recovery-drill-gitea-aabbcc', 1_860_000]
  ]);
});
