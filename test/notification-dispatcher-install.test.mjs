// Console R2-C1 (alert design A3): Setup installs C_NOTIFY through the Console native runtime installer and replaces
// only its workload in a component release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPONENT_ROLLOUTS, FOUNDATION_ARTIFACT_PATHS, NOTIFICATION_DISPATCHER_MANIFEST, componentReleaseManifestSpecs,
  notificationDispatcherInstallerArguments,
} from '../src/bootstrap.mjs';
import { MANAGED_CLUSTER_SCOPED_RESOURCES } from '../src/installation-contract.mjs';

const image = 'ghcr.io/opensphere-platform/opensphere-console-notification-dispatcher@sha256:' + 'a'.repeat(64);
// A target-layout lock (C_API and C_EXT present), as on RKE2.
const lock = { components: { notificationDispatcher: { image, sourceRevision: 'b'.repeat(40) }, consoleApi: { image: 'x' }, extensionController: { image: 'y' } }, auxiliaryArtifacts: {} };

test('the native installer gets the dispatcher image only when the release carries it and the installer accepts it', () => {
  const current = () => "  [string]$NotificationDispatcherImage = '',\n";
  const rollback = () => "  [string]$KubeContext = 'docker-desktop',\n";
  assert.deepEqual(notificationDispatcherInstallerArguments(lock, '/r', { read: current }), ['-NotificationDispatcherImage', image]);
  assert.deepEqual(notificationDispatcherInstallerArguments(lock, '/r', { read: rollback }), [], 'a rollback baseline installer has no such parameter');
  assert.deepEqual(notificationDispatcherInstallerArguments({ components: {} }, '/r', { read: current }), []);
});

test('the dispatcher manifest is a materialized release artifact and a component release target', () => {
  assert.ok(FOUNDATION_ARTIFACT_PATHS.includes('apps/notification-dispatcher/deploy.yaml'));
  assert.deepEqual(NOTIFICATION_DISPATCHER_MANIFEST.replacements, [['__OPENSPHERE_NOTIFICATION_DISPATCHER_IMAGE__', 'notificationDispatcher']]);
  const { base } = componentReleaseManifestSpecs(lock, ['notificationDispatcher']);
  assert.deepEqual(base.map(({ path }) => path), ['apps/notification-dispatcher/deploy.yaml']);
  assert.deepEqual(COMPONENT_ROLLOUTS.notificationDispatcher, [['opensphere-console', 'deployment/opensphere-notification-dispatcher', '600s']]);
});

test('the console-api TokenReview grant is a managed cluster-scoped object (uninstall removes it)', () => {
  for (const name of ['clusterrole/opensphere-console-api-token-reviewer', 'clusterrolebinding/opensphere-console-api-token-reviewer']) {
    assert.ok(MANAGED_CLUSTER_SCOPED_RESOURCES.clusterRbac.includes(name), name);
  }
});
