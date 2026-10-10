import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { stringify } from 'yaml';
import {
  FOUNDATION_BOOTSTRAP_PATH,
  FOUNDATION_RUNTIME_RBAC,
  OS_SHELL_CONTROL_CA,
  applyComponentRuntimePrerequisites,
  applyFoundationRuntimeRbac,
  describeComponentRuntimePrerequisite,
  foundationRbacIdentity,
  planFoundationRuntimeRbac,
  publishOsShellFoundationCa,
  selectFoundationRuntimeRbac
} from '../src/component-runtime-prerequisites.mjs';
import {
  KUBERNETES_EGRESS_SLOT,
  discoverRegistryKubernetesEgress,
  renderRegistryKubernetesEgress
} from '../src/registry-runtime-access.mjs';
import {
  OS_SHELL_MANIFEST,
  EXTENSION_CONTROLLER_MANIFEST,
  applyComponentReleaseInDependencyOrder,
  componentReleaseWorkloadManifests,
  renderManifest
} from '../src/bootstrap.mjs';

const NEW_REVISION = '7'.repeat(40);
const OLD_REVISION = '6'.repeat(40);
const RBAC = 'rbac.authorization.k8s.io/v1';
const rule = (apiGroups, resources, verbs, resourceNames) =>
  ({ apiGroups, resources, verbs, ...(resourceNames ? { resourceNames } : {}) });
const sa = (namespace, name, extra = {}) => ({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace }, ...extra });
const role = (kind, namespace, name, rules) =>
  ({ apiVersion: RBAC, kind, metadata: { name, ...(namespace ? { namespace } : {}) }, rules });
const binding = (kind, namespace, name, roleKind, subjects) => ({
  apiVersion: RBAC, kind, metadata: { name, ...(namespace ? { namespace } : {}) },
  roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: roleKind, name }, subjects
});

// The shape of Console foundation-bootstrap.json (39 resources at 658159ba): the verified profile beside
// objects that verifyFoundationProfile does not read (Namespaces, readers, CRDs, the controller ServiceAccount).
function foundationBundle({ samba = false } = {}) {
  const runtime = { kind: 'ServiceAccount', name: 'opensphere-foundation-runtime', namespace: 'opensphere-console' };
  const controller = { kind: 'ServiceAccount', name: 'foundation-control-plane', namespace: 'opensphere-foundation' };
  const custody = 'opensphere-foundation-secure-input';
  const controllerRoleRules = [
    rule(['apps'], ['deployments', 'statefulsets'], ['get', 'create', 'patch', 'deletecollection']),
    rule([''], ['persistentvolumeclaims'], ['create', 'patch']),
    ...(samba ? [
      rule([''], ['persistentvolumeclaims'], ['delete'], ['foundation-identity-samba-data']),
      rule([''], ['persistentvolumeclaims'], ['get'], ['foundation-identity-samba-data']),
      rule([''], ['pods'], ['list'])
    ] : []),
    rule([''], ['secrets'], ['get', 'create', 'patch', 'delete', 'deletecollection'])
  ];
  return {
    schema: 'opensphere.foundation-bootstrap/v1',
    source: 'https://github.com/opensphere-platform/OpenSphere-shell-foundation',
    sourceFiles: [],
    resources: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'opensphere-foundation', labels: { 'opensphere.io/managed-by': 'foundation' } } },
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: custody, labels: { 'opensphere.io/managed-by': 'foundation' } } },
      sa('opensphere-console', 'opensphere-foundation-runtime', { automountServiceAccountToken: false }),
      role('ClusterRole', null, 'opensphere-foundation-runtime', [
        rule(['foundation.opensphere.io'], ['foundationmodels', 'foundationmoduledescriptors'], ['get', 'list']),
        ...(samba ? [rule(['foundation.opensphere.io'], ['foundationmodels'], ['create'])] : []),
        rule(['authentication.k8s.io'], ['users'], ['impersonate:user-info'])
      ]),
      binding('ClusterRoleBinding', null, 'opensphere-foundation-runtime', 'ClusterRole', [runtime]),
      role('Role', 'opensphere-foundation', 'opensphere-foundation-runtime', [
        rule(['apps'], ['deployments', 'statefulsets'], ['get', 'list']),
        ...(samba ? [rule(['apps'], ['replicasets'], ['get']), rule(['apps'], ['deployments'], ['update'], ['foundation-control-plane'])] : []),
        rule([''], ['secrets'], ['get'], ['foundation-identity-samba-creds'])
      ]),
      binding('RoleBinding', 'opensphere-foundation', 'opensphere-foundation-runtime', 'Role', [runtime]),
      role('Role', custody, 'opensphere-foundation-runtime', [rule([''], ['configmaps', 'secrets'], ['get', 'list', 'create', 'delete'])]),
      binding('RoleBinding', custody, 'opensphere-foundation-runtime', 'Role', [runtime]),
      role('ClusterRole', null, 'opensphere-foundation-console-admins', [rule(['stackgres.io'], ['sgclusters'], ['get', 'list'])]),
      binding('ClusterRoleBinding', null, 'opensphere-foundation-console-admins', 'ClusterRole',
        [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'opensphere-console-admins' }]),
      role('ClusterRole', null, 'opensphere-foundation-profile-reader', [rule(['rbac.authorization.k8s.io'], ['clusterroles'], ['get'], ['opensphere-foundation-runtime'])]),
      binding('ClusterRoleBinding', null, 'opensphere-foundation-profile-reader', 'ClusterRole',
        [{ kind: 'ServiceAccount', name: 'opensphere-extension-controller', namespace: 'opensphere-console' }]),
      role('Role', 'opensphere-foundation', 'opensphere-extension-installation-profile-reader', [rule(['rbac.authorization.k8s.io'], ['roles'], ['get'])]),
      { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'opensphere-foundation-ingress', namespace: 'opensphere-console' }, spec: {} },
      { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'foundationmodels.foundation.opensphere.io' }, spec: {} },
      sa('opensphere-foundation', 'foundation-control-plane', { automountServiceAccountToken: true }),
      role('ClusterRole', null, 'opensphere-foundation-contract-controller', [
        rule(['foundation.opensphere.io'], ['foundationmodels/status'], ['get', 'patch', 'update']),
        ...(samba ? [rule(['foundation.opensphere.io'], ['foundationmodels'], ['patch'], ['identity']), rule([''], ['persistentvolumes'], ['get'])] : [])
      ]),
      binding('ClusterRoleBinding', null, 'opensphere-foundation-contract-controller', 'ClusterRole', [controller]),
      role('Role', 'opensphere-foundation', 'opensphere-foundation-contract-controller', controllerRoleRules),
      binding('RoleBinding', 'opensphere-foundation', 'opensphere-foundation-contract-controller', 'Role', [controller]),
      role('Role', custody, 'opensphere-foundation-contract-controller', [rule([''], ['secrets'], ['get', 'list', 'watch'])]),
      binding('RoleBinding', custody, 'opensphere-foundation-contract-controller', 'Role', [controller])
    ]
  };
}
const bundleText = (options) => `${JSON.stringify(foundationBundle(options), null, 2)}\n`;
// deploy.yaml carries the same objects after its Deployment (Console fca6b223 and later).
const controllerManifest = (options) => [
  stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'opensphere-extension-controller', namespace: 'opensphere-console' } }),
  ...foundationBundle(options).resources.map((document) => `${JSON.stringify(document, null, 2)}\n`)
].join('---\n');
const verifiedIdentities = FOUNDATION_RUNTIME_RBAC.map(foundationRbacIdentity);

const RESOURCE_KINDS = {
  serviceaccounts: 'ServiceAccount',
  'clusterroles.rbac.authorization.k8s.io': 'ClusterRole',
  'clusterrolebindings.rbac.authorization.k8s.io': 'ClusterRoleBinding',
  'roles.rbac.authorization.k8s.io': 'Role',
  'rolebindings.rbac.authorization.k8s.io': 'RoleBinding',
  configmap: 'ConfigMap'
};
const objectKey = (object) => `${object.kind}/${object.metadata.namespace ?? ''}/${object.metadata.name}`;

// An in-memory API server behind the exact kubectl argument shapes Setup uses. `replace` is client-side
// `kubectl apply`: top-level fields the document names replace the live ones (RBAC rules and subjects have no
// merge key), ConfigMap data and labels merge as maps, and fields only the live object has stay. `merge` is a
// writer that unions rules, which must never pass.
function fakeCluster({
  namespaces = ['opensphere-console', 'opensphere-foundation', 'opensphere-foundation-secure-input'],
  terminating = [],
  objects = [],
  applyMode = 'replace'
} = {}) {
  const store = new Map(objects.map((object) => [objectKey(object), structuredClone(object)]));
  const calls = [];
  let serial = 0;
  const write = (document) => {
    const live = store.get(objectKey(document));
    const next = { ...live, ...structuredClone(document),
      metadata: { ...live?.metadata, ...document.metadata, uid: live?.metadata?.uid ?? `uid-${++serial}`, resourceVersion: String(++serial) } };
    if (live?.data && document.data) next.data = { ...live.data, ...document.data };
    if (applyMode === 'merge' && live?.rules && document.rules) {
      next.rules = [...live.rules, ...document.rules.filter((item) => !live.rules.some((old) => JSON.stringify(old) === JSON.stringify(item)))];
    }
    store.set(objectKey(document), next);
  };
  const kubectl = (args, options = {}) => {
    calls.push({ args: [...args], input: options.input });
    const rest = [...args];
    const namespace = rest[0] === '-n' ? rest.splice(0, 2)[1] : null;
    if (rest[0] === 'get' && rest[1] === 'namespace') {
      if (!namespaces.includes(rest[2])) return '';
      return rest.includes('name') ? `namespace/${rest[2]}`
        : JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: rest[2],
          ...(terminating.includes(rest[2]) ? { deletionTimestamp: '2026-10-11T00:00:00Z' } : {}) } });
    }
    if (rest[0] === 'apply' && rest[1] === '-f' && rest[2] === '-' && rest.length === 3) {
      const document = JSON.parse(options.input);
      for (const item of document.kind === 'List' ? document.items : [document]) {
        if (item.metadata.namespace && !namespaces.includes(item.metadata.namespace)) throw new Error(`namespaces "${item.metadata.namespace}" not found`);
        write(item);
      }
      return '';
    }
    if (rest[0] === 'get' && RESOURCE_KINDS[rest[1]]) {
      const object = store.get(`${RESOURCE_KINDS[rest[1]]}/${namespace ?? ''}/${rest[2]}`);
      if (!object) {
        if (rest.includes('--ignore-not-found')) return '';
        throw new Error(`${rest[1]} "${rest[2]}" not found`);
      }
      return JSON.stringify(object);
    }
    throw new Error(`unexpected kubectl ${args.join(' ')}`);
  };
  return { kubectl, calls, store, writes: () => calls.filter((call) => call.args[0] === 'apply') };
}
const liveProfile = (options) => foundationBundle(options).resources
  .filter((document) => verifiedIdentities.includes(foundationRbacIdentity({
    kind: document.kind, namespace: document.metadata.namespace ?? null, name: document.metadata.name })))
  .map((document) => ({ ...document, metadata: { ...document.metadata, uid: `live-${document.metadata.name}`, resourceVersion: '1' } }));
const forwardPlan = () => planFoundationRuntimeRbac({
  sourceRevision: NEW_REVISION, bundle: bundleText({ samba: true }),
  baselineRevision: OLD_REVISION, baselineBundle: bundleText(), controllerManifest: controllerManifest({ samba: true })
});

test('Foundation step selects exactly the fifteen objects verifyFoundationProfile reads', () => {
  const selected = selectFoundationRuntimeRbac(bundleText({ samba: true }));
  assert.deepEqual(selected.map((document) => foundationRbacIdentity({
    kind: document.kind, namespace: document.metadata.namespace ?? null, name: document.metadata.name })), verifiedIdentities);
  assert.equal(selected.length, 15);
  for (const excluded of ['Namespace', 'NetworkPolicy', 'CustomResourceDefinition']) {
    assert.equal(selected.some((document) => document.kind === excluded), false, excluded);
  }
  assert.equal(selected.some((document) => document.metadata.name === 'foundation-control-plane'), false,
    'the controller ServiceAccount is not verified by C_EXT and is not applied here');
  assert.equal(selected.some((document) => /profile-reader/.test(document.metadata.name)), false);
  // A revision before 6d7739b5 declares a subset; a duplicate or a foreign contract is refused.
  const older = foundationBundle();
  older.resources = older.resources.filter((document) => document.metadata.namespace !== 'opensphere-foundation-secure-input');
  assert.equal(selectFoundationRuntimeRbac(JSON.stringify(older)).length, 11);
  const duplicated = foundationBundle();
  duplicated.resources.push(duplicated.resources[3]);
  assert.throws(() => selectFoundationRuntimeRbac(JSON.stringify(duplicated)), /more than once/);
  assert.throws(() => selectFoundationRuntimeRbac(JSON.stringify({ schema: 'other/v1', resources: [] })), /unsupported contract/);
});

test('Foundation profile is planned from both pinned revisions and applied only when it changed', () => {
  const changed = forwardPlan();
  assert.equal(changed.changed, true);
  assert.equal(changed.reason, 'profile-changed');
  assert.equal(changed.sourceRevision, NEW_REVISION);
  assert.equal(changed.baselineRevision, OLD_REVISION);
  assert.equal(changed.bootstrapSha256, `sha256:${createHash('sha256').update(bundleText({ samba: true })).digest('hex')}`);
  const unchanged = planFoundationRuntimeRbac({
    sourceRevision: NEW_REVISION, bundle: bundleText({ samba: true }),
    baselineRevision: OLD_REVISION, baselineBundle: bundleText({ samba: true }), controllerManifest: controllerManifest({ samba: true })
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.reason, 'profile-unchanged');
  // The controller compares rules as sets, so a reordered rule list is not a profile change.
  const reordered = foundationBundle({ samba: true });
  reordered.resources[5].rules.reverse();
  assert.equal(planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: JSON.stringify(reordered),
    baselineRevision: OLD_REVISION, baselineBundle: bundleText({ samba: true }) }).changed, false);
  // Without an installed profile to compare (forward repair, or an installed revision without the artifact)
  // the target profile is applied.
  assert.equal(planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: bundleText() }).reason, 'no-installed-baseline');
  assert.equal(planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: bundleText(),
    baselineRevision: OLD_REVISION, baselineBundle: null }).reason, 'installed-profile-absent');

  const skipped = fakeCluster();
  const record = applyFoundationRuntimeRbac(unchanged, { kubectl: skipped.kubectl });
  assert.equal(record.decision, 'unchanged');
  assert.deepEqual(record.objects, verifiedIdentities);
  assert.equal(skipped.calls.length, 0, 'an unchanged profile is neither written nor read');

  const cluster = fakeCluster({ objects: liveProfile() });
  const applied = applyFoundationRuntimeRbac(changed, { kubectl: cluster.kubectl, now: () => new Date('2026-10-11T01:02:03Z') });
  assert.equal(applied.decision, 'applied');
  assert.equal(applied.verifiedAt, '2026-10-11T01:02:03.000Z');
  assert.equal(cluster.writes().length, 1);
  const list = JSON.parse(cluster.writes()[0].input);
  assert.equal(list.kind, 'List');
  assert.deepEqual(list.items, changed.documents);
  assert.equal(cluster.calls.some((call) => call.args.some((arg) => /secret/i.test(arg)) && call.args[0] !== 'apply'), false);
  for (const document of changed.documents) {
    const live = cluster.store.get(objectKey(document));
    for (const field of ['rules', 'roleRef', 'subjects', 'automountServiceAccountToken']) {
      if (field in document) assert.deepEqual(live[field], document[field], `${objectKey(document)} ${field}`);
    }
  }
});

test('Foundation step replaces every rules list in full and refuses a merged read-back before the rollout', () => {
  const stale = rule(['apps'], ['deployments'], ['delete']);
  const live = liveProfile();
  const controllerRole = live.find((document) => document.kind === 'Role' && document.metadata.name === 'opensphere-foundation-contract-controller'
    && document.metadata.namespace === 'opensphere-foundation');
  controllerRole.rules.push(stale);
  const plan = forwardPlan();
  const target = plan.documents.find((document) => objectKey(document) === objectKey(controllerRole));

  const cluster = fakeCluster({ objects: live });
  applyFoundationRuntimeRbac(plan, { kubectl: cluster.kubectl });
  const sent = JSON.parse(cluster.writes()[0].input).items.find((document) => objectKey(document) === objectKey(controllerRole));
  assert.deepEqual(sent.rules, target.rules, 'the complete target list is sent, never a delta');
  assert.deepEqual(cluster.store.get(objectKey(controllerRole)).rules, target.rules);
  assert.equal(cluster.store.get(objectKey(controllerRole)).rules.some((item) => JSON.stringify(item) === JSON.stringify(stale)), false);
  assert.deepEqual(cluster.writes()[0].args, ['apply', '-f', '-'], 'client-side apply, as Prepare-FoundationPrerequisites.ps1');

  const merging = fakeCluster({ objects: live, applyMode: 'merge' });
  assert.throws(() => applyFoundationRuntimeRbac(plan, { kubectl: merging.kubectl }),
    /did not read back as the target profile: Role\/opensphere-foundation\/opensphere-foundation-contract-controller; no workload manifest was applied/);

  // Fields a client-side apply cannot remove fail closed exactly as verifyFoundationProfile would.
  for (const mutate of [
    (objects) => { objects.find((document) => document.kind === 'ClusterRole').aggregationRule = { clusterRoleSelectors: [] }; },
    (objects) => { objects.find((document) => document.kind === 'ServiceAccount').imagePullSecrets = [{ name: 'other' }]; }
  ]) {
    const objects = liveProfile();
    mutate(objects);
    assert.throws(() => applyFoundationRuntimeRbac(plan, { kubectl: fakeCluster({ objects }).kubectl }), /did not read back/);
  }
});

test('Foundation step restores the older profile when the same logic runs with an older lock', () => {
  const rollback = planFoundationRuntimeRbac({
    sourceRevision: OLD_REVISION, bundle: bundleText(),
    baselineRevision: NEW_REVISION, baselineBundle: bundleText({ samba: true }), controllerManifest: controllerManifest()
  });
  assert.equal(rollback.changed, true);
  assert.equal(rollback.reason, 'profile-changed');
  const cluster = fakeCluster({ objects: liveProfile({ samba: true }) });
  const record = applyFoundationRuntimeRbac(rollback, { kubectl: cluster.kubectl });
  assert.equal(record.decision, 'applied');
  assert.equal(record.sourceRevision, OLD_REVISION);
  assert.equal(record.baselineRevision, NEW_REVISION);
  for (const document of selectFoundationRuntimeRbac(bundleText())) {
    const live = cluster.store.get(objectKey(document));
    if (document.rules) assert.deepEqual(live.rules, document.rules, objectKey(document));
  }
  const controllerRole = cluster.store.get('Role/opensphere-foundation/opensphere-foundation-contract-controller');
  assert.equal(controllerRole.rules.some((item) => item.resourceNames?.includes('foundation-identity-samba-data')), false);
});

test('Foundation step touches no namespace and refuses before its first write when one is missing', () => {
  const cluster = fakeCluster({ namespaces: ['opensphere-console', 'opensphere-foundation'] });
  assert.throws(() => applyFoundationRuntimeRbac(forwardPlan(), { kubectl: cluster.kubectl }),
    /namespace opensphere-foundation-secure-input does not exist/);
  assert.equal(cluster.writes().length, 0);
  assert.equal(forwardPlan().documents.some((document) => document.kind === 'Namespace'), false);
});

test('Foundation artifact and the extension controller manifest must agree, or both declare nothing', () => {
  const disagreeing = controllerManifest({ samba: false });
  assert.throws(() => planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: bundleText({ samba: true }),
    baselineRevision: OLD_REVISION, baselineBundle: bundleText(), controllerManifest: disagreeing }),
  /disagree on ClusterRole\/opensphere-foundation-runtime/);
  assert.throws(() => planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: null,
    controllerManifest: controllerManifest() }), new RegExp(`${FOUNDATION_BOOTSTRAP_PATH.replaceAll('.', '\\.')} is missing`));
  const none = planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: null,
    controllerManifest: stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'opensphere-extension-controller' } }) });
  assert.equal(none.changed, false);
  assert.equal(applyFoundationRuntimeRbac(none, { kubectl: () => assert.fail('no call') }).decision, 'not-declared');
});

const CA = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIQb3BlbnNwaGVyZS1zaGVsbC1jYQ==\n-----END CERTIFICATE-----';
const caConfigMap = (namespace, data) => ({ apiVersion: 'v1', kind: 'ConfigMap',
  metadata: { name: OS_SHELL_CONTROL_CA, namespace, uid: `cm-${namespace}`, resourceVersion: '4' }, data });

test('OS Shell CA is published into opensphere-foundation from the console copy and read back', () => {
  const cluster = fakeCluster({ objects: [caConfigMap('opensphere-console', { 'ca.crt': CA })] });
  const record = publishOsShellFoundationCa({ kubectl: cluster.kubectl });
  assert.equal(record.decision, 'published');
  assert.equal(record.namespace, 'opensphere-foundation');
  assert.equal(record.certificateSha256, `sha256:${createHash('sha256').update(CA).digest('hex')}`);
  assert.equal(cluster.writes().length, 1);
  assert.deepEqual(JSON.parse(cluster.writes()[0].input), {
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { name: OS_SHELL_CONTROL_CA, namespace: 'opensphere-foundation', labels: { 'app.kubernetes.io/managed-by': 'opensphere-setup-cli' } },
    data: { 'ca.crt': CA }
  });
  assert.deepEqual(cluster.store.get(`ConfigMap/opensphere-foundation/${OS_SHELL_CONTROL_CA}`).data, { 'ca.crt': CA });
  assert.equal(cluster.calls.some((call) => call.args.some((arg) => /secret/i.test(arg))), false, 'no Secret is read');
  const reads = cluster.calls.filter((call) => call.args.includes('configmap')).map((call) => call.args[1]);
  assert.deepEqual(reads, ['opensphere-console', 'opensphere-foundation'], 'source read, then the projection read back');
});

test('OS Shell CA projection skips a missing namespace and never copies anything but a public certificate', () => {
  const absent = fakeCluster({ namespaces: ['opensphere-console'], objects: [caConfigMap('opensphere-console', { 'ca.crt': CA })] });
  const record = publishOsShellFoundationCa({ kubectl: absent.kubectl });
  assert.deepEqual({ decision: record.decision, reason: record.reason }, { decision: 'skipped', reason: 'namespace-missing' });
  assert.equal(absent.calls.length, 1, 'only the namespace was observed');
  assert.match(describeComponentRuntimePrerequisite(record), /opensphere-foundation namespace 없음/);

  assert.throws(() => publishOsShellFoundationCa({ kubectl: fakeCluster({ terminating: ['opensphere-foundation'],
    objects: [caConfigMap('opensphere-console', { 'ca.crt': CA })] }).kubectl }), /terminating/);
  for (const value of [
    `${CA}\n-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----`,
    '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIA==\n-----END EC PRIVATE KEY-----',
    undefined
  ]) {
    const cluster = fakeCluster({ objects: [caConfigMap('opensphere-console', value === undefined ? {} : { 'ca.crt': value })] });
    assert.throws(() => publishOsShellFoundationCa({ kubectl: cluster.kubectl }), /only a public CA certificate/);
    assert.equal(cluster.writes().length, 0);
  }
  // A projection that reads back with any other key is refused, even when ca.crt itself matches.
  const extra = fakeCluster({ objects: [caConfigMap('opensphere-console', { 'ca.crt': CA }),
    caConfigMap('opensphere-foundation', { 'ca.crt': CA, 'tls.key': 'unexpected' })] });
  assert.throws(() => publishOsShellFoundationCa({ kubectl: extra.kubectl }), /did not read back as exactly the public CA certificate/);
});

// installPreparedComponentRelease runs with only external I/O isolated: the order of Setup's own steps is real.
const bootstrapSource = await readFile(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
const installBegin = bootstrapSource.indexOf('function installPreparedComponentRelease(');
const installEnd = bootstrapSource.indexOf('\nfunction inventoryKey(', installBegin);
assert.ok(installBegin >= 0 && installEnd > installBegin);
function installHarness(cluster, events) {
  const kubectl = (args, options) => {
    events.push(`kubectl:${(args[0] === '-n' ? args.slice(2) : args).slice(0, 2).join(' ')}`);
    return cluster.kubectl(args, options);
  };
  return vm.runInNewContext(`(${bootstrapSource.slice(installBegin, installEnd)})`, {
    kubectl,
    console: { log: (line) => events.push(`log:${line}`) },
    runComponentMigrations: () => events.push('migrations'),
    componentReleaseWorkloadManifests: (_lock, _prepared, changed) => changed.map((component) => ({
      path: `${component === 'osShellControl' ? OS_SHELL_MANIFEST.path : EXTENSION_CONTROLLER_MANIFEST.path}#${component}`, yaml: 'kind: Deployment\n'
    })),
    applyComponentRuntimePrerequisites,
    describeComponentRuntimePrerequisite,
    applyComponentReleaseInDependencyOrder,
    applyRelease: (stage) => { for (const manifest of stage) events.push(`manifest:${manifest.path}`); },
    isLocalEdgeLock: () => false,
    waitForComponentRollouts: (components) => events.push(`wait:${components.join(',')}`)
  });
}

test('component release applies and re-reads the Foundation profile, then the CA, before any workload manifest', () => {
  const events = [], recorded = [];
  const cluster = fakeCluster({ objects: [...liveProfile(), caConfigMap('opensphere-console', { 'ca.crt': CA })] });
  installHarness(cluster, events)({ changedComponents: [] }, { foundation: { foundationRuntimeRbac: forwardPlan() } },
    'standard', 'https://console.example.test', '업그레이드', ['extensionController', 'osShellControl'], undefined,
    { onPrerequisite: (record) => recorded.push(record) });
  const first = (prefix) => events.findIndex((event) => event.startsWith(prefix));
  const controllerManifestApply = events.indexOf(`manifest:${EXTENSION_CONTROLLER_MANIFEST.path}#extensionController`);
  assert.ok(first('migrations') < first('kubectl:apply'));
  assert.ok(events.lastIndexOf('kubectl:get roles.rbac.authorization.k8s.io') < controllerManifestApply);
  assert.ok(events.lastIndexOf('kubectl:get configmap') < controllerManifestApply);
  assert.deepEqual(recorded.map((record) => [record.step, record.decision]),
    [['foundation-runtime-rbac', 'applied'], ['os-shell-ca-foundation', 'published']]);
  assert.ok(events.includes('log:[업그레이드] Foundation 실행 RBAC 15개 적용, 재확인 일치 (777777777777)'));
});

test('a Foundation read-back mismatch refuses before any workload manifest of the component release', () => {
  const events = [], recorded = [];
  const cluster = fakeCluster({ objects: liveProfile(), applyMode: 'merge' });
  const stale = cluster.store.get('Role/opensphere-foundation/opensphere-foundation-contract-controller');
  stale.rules.push(rule(['apps'], ['deployments'], ['delete']));
  assert.throws(() => installHarness(cluster, events)({ changedComponents: [] }, { foundation: { foundationRuntimeRbac: forwardPlan() } },
    'standard', 'https://console.example.test', '업그레이드', ['extensionController'], undefined,
    { onPrerequisite: (record) => recorded.push(record) }), /did not read back/);
  assert.equal(events.some((event) => event.startsWith('manifest:')), false);
  assert.equal(events.some((event) => event.startsWith('wait:')), false);
  assert.deepEqual(recorded, []);
});

test('an unchanged Foundation profile and an unchanged OS Shell leave both steps out', () => {
  const events = [];
  const unchanged = planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: bundleText(),
    baselineRevision: OLD_REVISION, baselineBundle: bundleText() });
  const records = applyComponentRuntimePrerequisites({ foundation: { foundationRuntimeRbac: unchanged } }, ['extensionController', 'consoleApi'], {
    kubectl: () => assert.fail('no cluster access'), onRecord: (record) => events.push(record.decision)
  });
  assert.deepEqual(events, ['unchanged']);
  assert.equal(records.length, 1);
  assert.deepEqual(applyComponentRuntimePrerequisites({ foundation: {} }, ['consoleApi'], { kubectl: () => assert.fail('no cluster access') }), []);
});

// Gap B is Setup's existing generic egress fill-in: fetchManifest discovers default/kubernetes and its ready
// HTTPS EndpointSlices whenever a source manifest carries the slot (as Console API does) and renderManifest
// replaces exactly one slot line. The real functions run here with only artifact and kubectl reads isolated.
const fetchBegin = bootstrapSource.indexOf('export async function fetchManifest(');
const fetchEnd = bootstrapSource.indexOf('\nasync function writeReleaseArtifact(', fetchBegin);
assert.ok(fetchBegin >= 0 && fetchEnd > fetchBegin);
const shellLines = (egress) => [
  'apiVersion: apps/v1', 'kind: Deployment', 'metadata: { name: opensphere-shell-api, namespace: opensphere-console }',
  'spec:', '  template:', '    spec:', '      automountServiceAccountToken: true', '      containers:', '        - name: api',
  '          image: __OPENSPHERE_OS_SHELL_CONTROL_IMAGE__', '          env:',
  '            - {name: OS_SHELL_RUNTIME_IMAGE, value: "__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__"}',
  '            - {name: OS_SHELL_OS_ARTIFACT_DIGEST, value: "__OPENSPHERE_OS_SHELL_OS_ARTIFACT_DIGEST__"}',
  '            - {name: MANIFEST, value: "__OPENSPHERE_OS_SHELL_MANIFEST_SHA256__"}',
  '            - {name: TEMPLATE, value: "__OPENSPHERE_OS_SHELL_RUNTIME_TEMPLATE_SHA256__"}',
  '            - {name: EVIDENCE, value: "__OPENSPHERE_OS_SHELL_RELEASE_EVIDENCE_REF__"}',
  ...(egress ? ['---', 'apiVersion: networking.k8s.io/v1', 'kind: NetworkPolicy',
    'metadata: { name: opensphere-shell-api-kubernetes-egress, namespace: opensphere-console }',
    'spec:', '  podSelector: { matchLabels: { app: opensphere-shell-api } }', '  policyTypes: [Egress]', '  egress:',
    '    # The system actor admission reads the Kubernetes API. Installation renders the exact Service and',
    '    # endpoint addresses, as for C_API (Install-ConsoleNativeRuntime.ps1); never 0.0.0.0/0.',
    `    - ${KUBERNETES_EGRESS_SLOT}`] : [])
].join('\n') + '\n';
const apiService = { metadata: { name: 'kubernetes', namespace: 'default' },
  spec: { clusterIP: '10.43.0.1', clusterIPs: ['10.43.0.1'], ports: [{ name: 'https', protocol: 'TCP', port: 443 }] } };
const apiSlices = { items: [{ metadata: { namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } }, addressType: 'IPv4',
  ports: [{ name: 'https', protocol: 'TCP', port: 6443 }],
  endpoints: ['10.10.1.31', '10.10.1.32', '10.10.1.33'].map((address) => ({ addresses: [address], conditions: { ready: true } })) }] };
function shellTransition() {
  const image = (repository) => `ghcr.io/opensphere-platform/${repository}@sha256:${'b'.repeat(64)}`;
  return {
    channel: 'edge', sourceRevision: NEW_REVISION, releaseDigest: `sha256:${'d'.repeat(64)}`,
    components: {}, changedComponents: [], changedAuxiliaryArtifacts: ['cliArtifacts', 'osShellControl', 'osShellRuntime'],
    auxiliaryArtifacts: Object.fromEntries(['cliArtifacts', 'osShellControl', 'osShellRuntime'].map((name) =>
      [name, { repository: `opensphere-${name.toLowerCase()}`, image: image(`opensphere-${name.toLowerCase()}`), sourceRevision: NEW_REVISION }]))
  };
}
function fetchHarness(source, kubectlCalls) {
  return vm.runInNewContext(`(${bootstrapSource.slice(fetchBegin, fetchEnd).replace(/^export /, '')})`, {
    OS_SHELL_MANIFEST, EXTENSION_CONTROLLER_MANIFEST, KUBERNETES_EGRESS_SLOT, renderManifest,
    discoverRegistryKubernetesEgress, renderRegistryKubernetesEgress,
    fetchReleaseArtifact: async (_lock, path) => path === OS_SHELL_MANIFEST.path ? source : 'module.exports = {};\n',
    renderKnowledgeManifest: async () => assert.fail('not a Gateway manifest'),
    kubectl: (args) => {
      kubectlCalls.push(args.join(' '));
      if (args.includes('service')) return JSON.stringify(apiService);
      if (args.includes('endpointslices.discovery.k8s.io')) return JSON.stringify(apiSlices);
      throw new Error(`unexpected kubectl ${args.join(' ')}`);
    }
  });
}

test('OS Shell component release renders the Kubernetes API egress with the Console API discovery rules', async () => {
  const lock = shellTransition(), calls = [];
  const rendered = await fetchHarness(shellLines(true), calls)(lock, OS_SHELL_MANIFEST, 'standard', 'https://console.example.test', 'development',
    { sourceRevision: NEW_REVISION, fetchFn: async () => assert.fail('artifacts are isolated') });
  assert.deepEqual(calls, [
    '-n default get service kubernetes -o json',
    '-n default get endpointslices.discovery.k8s.io -l kubernetes.io/service-name=kubernetes -o json'
  ]);
  assert.doesNotMatch(rendered, /__OPENSPHERE_/);
  for (const [cidr, port] of [['10.43.0.1/32', 443], ['10.10.1.31/32', 6443], ['10.10.1.32/32', 6443], ['10.10.1.33/32', 6443]]) {
    assert.ok(rendered.includes(`    - ${JSON.stringify({ to: [{ ipBlock: { cidr } }], ports: [{ protocol: 'TCP', port }] })}`), cidr);
  }
  assert.equal([...rendered.matchAll(/"cidr":"([^"]+)"/g)].length, 4, 'exactly the Service and the ready endpoints, never a wider block');
  assert.ok(rendered.includes(`sha256:${createHash('sha256').update(shellLines(true)).digest('hex')}`),
    'the manifest evidence stays the digest of the unrendered source, as the native installer computes it');
  // The single-owner OS Shell manifest is applied complete, so the policy reaches the cluster with the workloads.
  const applied = componentReleaseWorkloadManifests(lock, { foundation: { release: [] }, base: [{ path: OS_SHELL_MANIFEST.path, yaml: rendered }] }, ['osShellControl']);
  assert.equal(applied.length, 1);
  assert.match(applied[0].yaml, /name: opensphere-shell-api-kubernetes-egress/);
  assert.match(applied[0].yaml, /10\.10\.1\.31\/32/);
});

test('an OS Shell manifest without the egress slot (older Console) renders without any API discovery', async () => {
  const calls = [];
  const rendered = await fetchHarness(shellLines(false), calls)(shellTransition(), OS_SHELL_MANIFEST, 'standard', 'https://console.example.test',
    'development', { sourceRevision: OLD_REVISION, fetchFn: async () => assert.fail('artifacts are isolated') });
  assert.deepEqual(calls, []);
  assert.doesNotMatch(rendered, /ipBlock|kubernetes-egress|__OPENSPHERE_/);
});
