// Re-review 3, N3 (2026-09-26): localhost forward repair must not plan, continue or write over a
// Console Knowledge claim. The records are the ones Console's real Knowledge delivery writer and
// promotion leave (published by Console scripts/sync-knowledge-claim-fixture.mjs --setup-root).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertForwardRepair, installationRecordDigest } from '../src/forward-repair.mjs';
import { upgrade } from '../src/bootstrap.mjs';

const claim = JSON.parse(readFileSync(new URL('./fixtures/knowledge-claim-v1.json', import.meta.url), 'utf8'));
const record = (release, state) => ({ apiVersion: 'v1', kind: 'ConfigMap',
  metadata: { namespace: 'opensphere-console', name: 'opensphere-installation-lock', uid: 'original-object', resourceVersion: '10' },
  data: { 'release.json': JSON.stringify(release),
    'config.json': JSON.stringify({ architecture: 'supabase-data-identity+gitea-change-authority', channel: 'edge', consoleUrl: 'https://localhost:1114',
      storageClass: 'standard', authEnvironment: 'development', releaseDigest: release.releaseDigest, initialAdmin: { username: 'admin' } }),
    'state.json': JSON.stringify(state) } });
// Before promotion the record holds the base release; after it, the promoted target.
const stages = [
  ['before promotion', claim.beforePromotion, claim.baseLock, claim.targetLock],
  ['after promotion', claim.afterPromotion, claim.targetLock, claim.targetLock],
];
const REFUSED = /Console Knowledge release \(operation 33333333-3333-4333-8333-333333333333\) holds the installation record; forward repair neither plans nor writes over it/;

function repairRuntime(records, events) {
  let reads = 0;
  const fail = (name) => () => { events.push(name); throw new Error(`${name} must not run over a Knowledge claim`); };
  return {
    currentKubeContext: () => 'docker-desktop',
    readInstallationRecord: () => records[Math.min(reads++, records.length - 1)],
    readInstallationLock: () => JSON.parse(records[0].data['release.json']),
    readInstallationConfig: () => JSON.parse(records[0].data['config.json']),
    verifyReleaseLock: async () => events.push('supply'),
    preflight: () => events.push('preflight'), ensureManagedNamespaces: () => events.push('namespaces'), ensureRegistryPullSecrets: () => events.push('registry'),
    prepareComponentRelease: async (release) => { events.push('prepare'); return { foundation: { root: release.sourceRevision, release: [], migration: null }, base: [], all: [{ path: 'c.yaml', yaml: 'c' }] }; },
    prepareForwardRepairInventory: async () => { events.push('prepare-inventory'); return { inventory: [], manifests: [] }; },
    readReleaseInventory: () => [{ name: 'complete-release' }],
    readBeszelBootstrapHistory: () => null,
    releaseResourceInventory: () => [],
    recordInstallationState: fail('record'), recordReleaseInventory: fail('inventory'),
    runForwardRepairBootstrap: fail('bootstrap'), installPreparedComponentRelease: fail('install'), installPreparedRelease: fail('install'),
    pruneReleaseResources: fail('prune'), waitForComponentRollouts: fail('wait'), verifyInstallation: fail('verify'),
  };
}
const mutations = (events) => events.filter((e) => ['record', 'inventory', 'bootstrap', 'install', 'prune'].includes(e));

for (const [name, observed, previous, target] of stages) {
  test(`forward repair plan and run refuse a real Knowledge claim ${name}`, async () => {
    const claimed = record(observed.release, observed.state);
    const digest = installationRecordDigest(claimed);
    // The repair plan (CLI --repair-plan) and the run share this check.
    assert.throws(() => assertForwardRepair({ previous, target, record: claimed, expectedRecordDigest: digest, context: 'docker-desktop' }), REFUSED);
    const events = [];
    await assert.rejects(upgrade(previous, target, { forwardRepairRecordDigest: digest, runtime: repairRuntime([claimed], events) }), REFUSED);
    assert.deepEqual(mutations(events), [], 'no bootstrap, install, prune, inventory or record write');
  });
}

test('the same record without the Knowledge claim is otherwise a valid repair plan (control)', () => {
  const [, observed, previous, target] = stages[0];
  const state = { ...observed.state, phase: 'Failed', failureCode: 'installation-verification-incomplete' };
  delete state.knowledgeUpdate; delete state.transition;
  const plain = record(observed.release, state);
  const plan = assertForwardRepair({ previous, target, record: plain, expectedRecordDigest: installationRecordDigest(plain), context: 'docker-desktop' });
  assert.equal(plan.targetReleaseDigest, target.releaseDigest);
});

test('a Knowledge claim appearing after the plan was reviewed stops the run before any write', async () => {
  const [, observed, previous, target] = stages[0];
  const state = { ...observed.state, phase: 'Failed', failureCode: 'installation-verification-incomplete' };
  delete state.knowledgeUpdate; delete state.transition;
  const reviewed = record(observed.release, state), claimedLater = record(observed.release, observed.state);
  const events = [];
  await assert.rejects(upgrade(previous, target, { forwardRepairRecordDigest: installationRecordDigest(reviewed),
    runtime: repairRuntime([reviewed, claimedLater], events) }), REFUSED);
  assert.ok(events.includes('prepare'), 'the first check passed and preparation ran');
  assert.deepEqual(mutations(events), [], 'the re-check before the first change refused');
});
