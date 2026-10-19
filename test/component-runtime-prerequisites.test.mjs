import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { parseAllDocuments, stringify } from 'yaml';
import {
  FOUNDATION_ADMISSION,
  ADMISSION_PROBE_SUBJECT,
  FOUNDATION_BOOTSTRAP_PATH,
  FOUNDATION_RUNTIME_RBAC,
  foundationAdmissionObjectMatches,
  selectFoundationAdmission,
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
  discoverKubernetesApiCiliumPolicy,
  discoverRegistryKubernetesEgress,
  renderRegistryKubernetesEgress
} from '../src/registry-runtime-access.mjs';
import {
  OS_SHELL_MANIFEST,
  EXTENSION_CONTROLLER_MANIFEST,
  CONSOLE_API_MANIFEST,
  applyComponentReleaseInDependencyOrder,
  splitComponentReleaseCrds,
  customResourceDefinitionNames,
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
  'validatingadmissionpolicies.admissionregistration.k8s.io': 'ValidatingAdmissionPolicy',
  'validatingadmissionpolicybindings.admissionregistration.k8s.io': 'ValidatingAdmissionPolicyBinding',
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
  applyMode = 'replace',
  // Server dry runs of an unapproved FoundationModel that API servers still admit after the policy is written.
  admitProbes = 0,
  probeError = null
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
    if (rest[0] === 'create' && rest.includes('--dry-run=server')) {
      if (probeError) throw Object.assign(new Error('kubectl create failed'), { stderr: probeError });
      const policy = store.get('ValidatingAdmissionPolicy//opensphere-foundation-model-writer');
      if (!policy || admitProbes-- > 0) return 'foundationmodel.foundation.opensphere.io/setup-admission-probe created (server dry run)';
      throw Object.assign(new Error('kubectl create failed'), { stderr: 'The foundationmodels "setup-admission-probe" is invalid: : ValidatingAdmissionPolicy '
        + "'opensphere-foundation-model-writer' with binding 'opensphere-foundation-model-writer' denied request: FoundationModel setup-admission-probe is not approved" });
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
    /did not read back as the target profile: Role\/opensphere-foundation\/opensphere-foundation-contract-controller\. It was sent, so the cluster RBAC may already be changed\. No workload manifest was applied\./);

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
    splitComponentReleaseCrds,
    customResourceDefinitionNames,
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
  // Review 2026-10-11 (Phobos): the RBAC was sent, so the failure is recorded as a possible change,
  // never as "no workload applied, nothing changed".
  assert.deepEqual(recorded.map((record) => [record.step, record.decision, record.mismatched]),
    [['foundation-runtime-rbac', 'changed-unverified', ['Role/opensphere-foundation/opensphere-foundation-contract-controller']]]);
});

test('a prerequisite whose apply or read-back fails after the write records that the cluster may be changed', () => {
  const failing = (fail) => {
    const cluster = fakeCluster({ objects: [...liveProfile(), caConfigMap('opensphere-console', { 'ca.crt': CA })] });
    return { ...cluster, kubectl: (args, options = {}) => {
      if (fail(args)) throw new Error('kubectl: connection reset');
      return cluster.kubectl(args, options);
    } };
  };
  const cases = [
    [['extensionController'], (args) => args[0] === 'apply', 'foundation-runtime-rbac', 'apply-outcome-unknown', /apply did not complete; the cluster RBAC may be partly changed/],
    [['extensionController'], (args) => args.includes('get') && args.includes('roles.rbac.authorization.k8s.io'), 'foundation-runtime-rbac', 'changed-unverified', /was sent but could not be read back/],
    [['osShellControl'], (args) => args[0] === 'apply', 'os-shell-ca-foundation', 'apply-outcome-unknown', /apply did not complete; it may already be changed/],
    [['osShellControl'], (args) => args[0] === '-n' && args[1] === 'opensphere-foundation' && args.includes('configmap'), 'os-shell-ca-foundation', 'changed-unverified', /was sent but could not be read back/]
  ];
  for (const [changed, fail, step, decision, message] of cases) {
    const recorded = [], cluster = failing(fail);
    assert.throws(() => applyComponentRuntimePrerequisites({ foundation: { foundationRuntimeRbac: forwardPlan() } }, changed,
      { kubectl: cluster.kubectl, onRecord: (record) => recorded.push(record) }), message);
    assert.deepEqual(recorded.map((record) => [record.step, record.decision]), [[step, decision]], step + ' ' + decision);
    assert.ok(describeComponentRuntimePrerequisite(recorded[0]).includes('바뀌었을 수 있음'), 'the console line says it may be changed');
  }
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
const CILIUM_CRD = '{"metadata":{"name":"ciliumnetworkpolicies.cilium.io"},"spec":{"group":"cilium.io","names":{"kind":"CiliumNetworkPolicy"}}}';
const CRD_READ = 'get customresourcedefinition ciliumnetworkpolicies.cilium.io --ignore-not-found -o json';
function fetchHarness(source, kubectlCalls, { cilium = false } = {}) {
  return vm.runInNewContext(`(${bootstrapSource.slice(fetchBegin, fetchEnd).replace(/^export /, '')})`, {
    OS_SHELL_MANIFEST, EXTENSION_CONTROLLER_MANIFEST, CONSOLE_API_MANIFEST, KUBERNETES_EGRESS_SLOT, renderManifest,
    discoverRegistryKubernetesEgress, renderRegistryKubernetesEgress, discoverKubernetesApiCiliumPolicy,
    fetchReleaseArtifact: async (_lock, path) => path.endsWith('/deploy.yaml') ? source : 'module.exports = {};\n',
    renderKnowledgeManifest: async () => assert.fail('not a Gateway manifest'),
    kubectl: (args) => {
      kubectlCalls.push(args.join(' '));
      if (args.includes('service')) return JSON.stringify(apiService);
      if (args.includes('endpointslices.discovery.k8s.io')) return JSON.stringify(apiSlices);
      if (args.join(' ') === CRD_READ) return cilium ? CILIUM_CRD : '';
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
    '-n default get endpointslices.discovery.k8s.io -l kubernetes.io/service-name=kubernetes -o json',
    CRD_READ
  ]);
  assert.doesNotMatch(rendered, /__OPENSPHERE_/);
  assert.doesNotMatch(rendered, /CiliumNetworkPolicy/, 'a cluster without the Cilium policy API gets no Cilium document');
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

test('OS Shell component release carries its Cilium policy in the same applied manifest as the NetworkPolicy', async () => {
  const lock = shellTransition(), calls = [];
  const rendered = await fetchHarness(shellLines(true), calls, { cilium: true })(lock, OS_SHELL_MANIFEST, 'standard',
    'https://console.example.test', 'development', { sourceRevision: NEW_REVISION, fetchFn: async () => assert.fail('artifacts are isolated') });
  assert.equal(calls.at(-1), CRD_READ);
  assert.ok(rendered.includes(`sha256:${createHash('sha256').update(shellLines(true)).digest('hex')}`),
    'the appended policy does not change the manifest evidence digest');
  const applied = componentReleaseWorkloadManifests(lock, { foundation: { release: [] }, base: [{ path: OS_SHELL_MANIFEST.path, yaml: rendered }] }, ['osShellControl']);
  assert.equal(applied.length, 1);
  const documents = parseAllDocuments(applied[0].yaml).map((document) => document.toJS()).filter(Boolean);
  const policies = documents.filter((document) => /NetworkPolicy$/.test(document.kind) && document.metadata.name === 'opensphere-shell-api-kubernetes-egress');
  assert.deepEqual(policies.map((document) => document.kind), ['NetworkPolicy', 'CiliumNetworkPolicy']);
  const [standard, cilium] = policies;
  assert.deepEqual(cilium.metadata, { name: 'opensphere-shell-api-kubernetes-egress', namespace: 'opensphere-console',
    labels: { 'app.kubernetes.io/part-of': 'opensphere-console', 'app.kubernetes.io/managed-by': 'opensphere-setup' } });
  assert.deepEqual(cilium.spec.endpointSelector.matchLabels, standard.spec.podSelector.matchLabels, 'the same Pods as the NetworkPolicy');
  assert.deepEqual(cilium.spec.egress, [{ toEntities: ['kube-apiserver'],
    toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }, { port: '6443', protocol: 'TCP' }] }] }]);
});

test('Console API component path keeps its behaviour: no Cilium document and no Cilium API read', async () => {
  const image = `ghcr.io/opensphere-platform/opensphere-console-api@sha256:${'c'.repeat(64)}`, calls = [];
  const source = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata: { name: opensphere-console-api, namespace: opensphere-console }',
    'spec:', '  template:', '    spec:', '      containers:', '        - name: api', '          image: __OPENSPHERE_CONSOLE_API_IMAGE__',
    '---', 'apiVersion: networking.k8s.io/v1', 'kind: NetworkPolicy', 'metadata: { name: opensphere-console-api-kubernetes-egress, namespace: opensphere-console }',
    'spec:', '  podSelector: { matchLabels: { app.kubernetes.io/name: opensphere-console-api } }', '  policyTypes: [Egress]', '  egress:',
    `    - ${KUBERNETES_EGRESS_SLOT}`].join('\n') + '\n';
  const rendered = await fetchHarness(source, calls, { cilium: true })({ channel: 'edge', sourceRevision: NEW_REVISION,
    releaseDigest: `sha256:${'d'.repeat(64)}`, components: { consoleApi: { image } } }, CONSOLE_API_MANIFEST, 'standard',
  'https://console.example.test', 'development', { sourceRevision: NEW_REVISION, fetchFn: async () => assert.fail('artifacts are isolated') });
  assert.equal(calls.includes(CRD_READ), false);
  assert.match(rendered, /10\.10\.1\.31\/32/);
  assert.doesNotMatch(rendered, /CiliumNetworkPolicy/);
});

// Console Provider-list decoupling D-C2 (user decision 2026-10-19): from that Console revision the Foundation RBAC
// names no FoundationModel and the bundle carries the name policy and its binding. Setup applies them, and waits for the
// API server to type-check the policy, before the name-free RBAC.
const ADMISSION = 'admissionregistration.k8s.io/v1';
const modelPolicy = () => ({ apiVersion: ADMISSION, kind: 'ValidatingAdmissionPolicy', metadata: { name: 'opensphere-foundation-model-writer' },
  spec: { failurePolicy: 'Fail', paramKind: { apiVersion: 'plugins.opensphere.io/v1alpha1', kind: 'UIPluginRegistration' },
    matchConstraints: { resourceRules: [{ apiGroups: ['foundation.opensphere.io'], apiVersions: ['*'], operations: ['CREATE', 'UPDATE'], resources: ['foundationmodels'] }] },
    validations: [{ expression: 'object.metadata.name in variables.bootstrap || object.metadata.name in variables.declared' }] } });
const modelBinding = () => ({ apiVersion: ADMISSION, kind: 'ValidatingAdmissionPolicyBinding', metadata: { name: 'opensphere-foundation-model-writer' },
  spec: { policyName: 'opensphere-foundation-model-writer', validationActions: ['Deny'],
    paramRef: { name: 'foundation', namespace: 'opensphere-console', parameterNotFoundAction: 'Deny' } } });
// The D-C2 bundle: the name policy after the namespaces, and FoundationModel writes without names.
function decoupledBundle() {
  const bundle = foundationBundle({ samba: true });
  const runtime = bundle.resources.find((d) => d.kind === 'ClusterRole' && d.metadata.name === 'opensphere-foundation-runtime');
  runtime.rules = runtime.rules.map((r) => r.resources.includes('foundationmodels') && r.verbs.includes('create') ? rule(['foundation.opensphere.io'], ['foundationmodels'], ['create', 'patch']) : r);
  const controller = bundle.resources.find((d) => d.kind === 'ClusterRole' && d.metadata.name === 'opensphere-foundation-contract-controller');
  controller.rules = controller.rules.map((r) => r.resources.includes('foundationmodels') ? rule(['foundation.opensphere.io'], ['foundationmodels'], ['patch']) : r);
  bundle.resources.splice(2, 0, modelPolicy(), modelBinding());
  bundle.schema = 'opensphere.foundation-bootstrap/v2';
  return bundle;
}
const decoupledText = () => `${JSON.stringify(decoupledBundle(), null, 2)}\n`;
const decoupledManifest = () => [
  stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'opensphere-extension-controller', namespace: 'opensphere-console' } }),
  ...decoupledBundle().resources.map((document) => `${JSON.stringify(document, null, 2)}\n`)
].join('---\n');
const decoupledPlan = () => planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: decoupledText(),
  baselineRevision: OLD_REVISION, baselineBundle: bundleText({ samba: true }), controllerManifest: decoupledManifest() });
// The API server's view of a written policy: its defaults, a generation and the type-check status.
function serverView(cluster, { typeChecked = true, warnings = [] } = {}) {
  const original = cluster.kubectl;
  return (args, options) => {
    const out = original(args, options);
    if (args[0] === 'get' && args[1] === 'validatingadmissionpolicies.admissionregistration.k8s.io' && out) {
      const object = JSON.parse(out);
      object.spec.matchConstraints = { ...object.spec.matchConstraints, matchPolicy: 'Equivalent', namespaceSelector: {}, objectSelector: {} };
      object.spec.matchConstraints.resourceRules = object.spec.matchConstraints.resourceRules.map((r) => ({ ...r, scope: '*' }));
      object.metadata.generation = 1;
      object.status = { observedGeneration: typeChecked ? 1 : 0, typeChecking: warnings.length ? { expressionWarnings: warnings } : {} };
      return JSON.stringify(object);
    }
    return out;
  };
}

test('D-C2: the FoundationModel name policy is selected with its binding, and both or neither', () => {
  assert.deepEqual(FOUNDATION_ADMISSION.map(foundationRbacIdentity), [
    'ValidatingAdmissionPolicy/opensphere-foundation-model-writer', 'ValidatingAdmissionPolicyBinding/opensphere-foundation-model-writer']);
  assert.deepEqual(selectFoundationAdmission(decoupledText()).map((d) => d.kind), ['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding']);
  assert.deepEqual(selectFoundationAdmission(bundleText({ samba: true })), [], 'an older bundle declares none');
  const half = decoupledBundle(); half.resources = half.resources.filter((d) => d.kind !== 'ValidatingAdmissionPolicyBinding');
  assert.throws(() => selectFoundationAdmission(JSON.stringify(half)), /without its binding/);
  const wrongApi = decoupledBundle(); wrongApi.resources[2].apiVersion = 'admissionregistration.k8s.io/v1beta1';
  assert.throws(() => selectFoundationAdmission(JSON.stringify(wrongApi)), /unexpected API version/);
  // The selection of the fifteen RBAC objects is unchanged by the policy.
  assert.deepEqual(selectFoundationRuntimeRbac(decoupledText()).map((document) => foundationRbacIdentity({
    kind: document.kind, namespace: document.metadata.namespace ?? null, name: document.metadata.name })), verifiedIdentities);
});

test('D-C2: name-free FoundationModel RBAC without the name policy is refused before anything is written', () => {
  const unbounded = decoupledBundle(); unbounded.resources = unbounded.resources.filter((d) => !d.kind.startsWith('ValidatingAdmissionPolicy'));
  assert.throws(() => planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: JSON.stringify(unbounded),
    baselineRevision: OLD_REVISION, baselineBundle: bundleText({ samba: true }) }), /without names but declares no FoundationModel name policy/);
  // The older RBAC (create without names beside a named patch) needs no policy.
  assert.equal(forwardPlan().admission.length, 0);
  // The extension controller manifest must carry the same policy objects.
  const disagreeing = decoupledBundle(); disagreeing.resources[2].spec.failurePolicy = 'Ignore';
  assert.throws(() => planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: JSON.stringify(disagreeing),
    controllerManifest: decoupledManifest() }), /disagree on ValidatingAdmissionPolicy\/opensphere-foundation-model-writer/);
});

test('D-C2: the name policy is applied, type-checked and read back before the name-free RBAC, in a separate write', () => {
  const plan = decoupledPlan();
  assert.equal(plan.changed, true);
  assert.match(plan.admissionDigest, /^sha256:[a-f0-9]{64}$/);
  const cluster = fakeCluster({ objects: liveProfile({ samba: true }) });
  const slept = [];
  let reads = 0;
  const view = serverView(cluster);
  // The first read sees a policy the API server has not type-checked yet.
  const kubectl = (args, options) => {
    if (args[0] === 'get' && args[1] === 'validatingadmissionpolicies.admissionregistration.k8s.io' && ++reads === 1) {
      const object = JSON.parse(cluster.kubectl(args, options)); object.metadata.generation = 1; object.status = {}; return JSON.stringify(object);
    }
    return view(args, options);
  };
  const record = applyFoundationRuntimeRbac(plan, { kubectl, sleep: (ms) => slept.push(ms), now: () => new Date('2026-10-19T01:02:03Z') });
  assert.equal(record.decision, 'applied');
  assert.deepEqual(record.admissionObjects, FOUNDATION_ADMISSION.map(foundationRbacIdentity));
  assert.equal(record.admissionDigest, plan.admissionDigest);
  assert.deepEqual(slept, [500, 500, 500, 500, 500], 'Setup waited for the type check once, then between the dry-run probes');
  assert.deepEqual(record.admissionProbe, { probe: 'denied', attempts: 5 });
  const writes = cluster.writes();
  assert.equal(writes.length, 2, 'the policy and the RBAC are separate writes');
  assert.deepEqual(JSON.parse(writes[0].input).items.map((d) => d.kind), ['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding']);
  assert.ok(JSON.parse(writes[1].input).items.every((d) => !d.kind.startsWith('ValidatingAdmissionPolicy')));
  const order = cluster.calls.map((call) => call.args.slice(0, 2).join(' '));
  assert.ok(order.indexOf('get validatingadmissionpolicybindings.admissionregistration.k8s.io') < order.lastIndexOf('apply -f'),
    'the policy is read back before the RBAC write');
  assert.ok(order.lastIndexOf('create -f') < order.lastIndexOf('apply -f'), 'the enforcement probes run before the RBAC write');
  const probe = cluster.calls.find((call) => call.args[0] === 'create');
  assert.deepEqual(probe.args, ['create', '-f', '-', '--dry-run=server', '-o', 'name', '--as', ADMISSION_PROBE_SUBJECT]);
  assert.match(describeComponentRuntimePrerequisite(record), /^FoundationModel 이름 정책 2개와 Foundation 실행 RBAC 15개 적용, 재확인 일치/);
});

test('D-C2: a policy that does not read back, is never type-checked or has warnings leaves the RBAC untouched', () => {
  for (const [label, options] of [['warnings', { warnings: [{ fieldRef: 'spec.validations[0].expression', warning: 'undefined field' }] }],
    ['never type-checked', { typeChecked: false }]]) {
    const cluster = fakeCluster({ objects: liveProfile({ samba: true }) });
    assert.throws(() => applyFoundationRuntimeRbac(decoupledPlan(), { kubectl: serverView(cluster, options), sleep: () => {}, typeCheckAttempts: 3 }),
      (error) => /FoundationModel name policy did not read back as the target or is not type-checked/.test(error.message)
        && error.prerequisiteRecord?.decision === 'changed-unverified', label);
    assert.equal(cluster.writes().length, 1, `${label}: only the policy write happened`);
    assert.deepEqual(cluster.store.get('ClusterRole//opensphere-foundation-runtime').rules,
      liveProfile({ samba: true }).find((d) => d.kind === 'ClusterRole' && d.metadata.name === 'opensphere-foundation-runtime').rules, `${label}: RBAC unchanged`);
  }
  // An apply that fails leaves the RBAC unwritten as well.
  const failing = fakeCluster({ objects: liveProfile({ samba: true }) });
  const kubectl = (args, options) => { if (args[0] === 'apply') throw new Error('admission webhook unavailable'); return failing.kubectl(args, options); };
  assert.throws(() => applyFoundationRuntimeRbac(decoupledPlan(), { kubectl }), (error) => error.prerequisiteRecord?.decision === 'apply-outcome-unknown');
  // The comparison is the controller's: Kubernetes defaults pass, an edit does not.
  const expected = modelPolicy();
  const observed = { ...structuredClone(expected), metadata: { ...expected.metadata, generation: 2 }, status: { observedGeneration: 2, typeChecking: {} } };
  observed.spec.matchConstraints = { ...observed.spec.matchConstraints, matchPolicy: 'Equivalent', namespaceSelector: {}, objectSelector: {} };
  assert.equal(foundationAdmissionObjectMatches(expected, observed), true);
  assert.equal(foundationAdmissionObjectMatches(expected, { ...observed, spec: { ...observed.spec, failurePolicy: 'Ignore' } }), false);
  assert.equal(foundationAdmissionObjectMatches(modelBinding(), { ...modelBinding(), spec: { ...modelBinding().spec, validationActions: ['Audit'] } }), false);
});

test('D-C2: an unchanged policy and RBAC are neither written nor read; a changed policy alone is a profile change', () => {
  const same = planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: decoupledText(), baselineRevision: OLD_REVISION,
    baselineBundle: decoupledText(), controllerManifest: decoupledManifest() });
  assert.equal(same.changed, false);
  // Review 2026-10-19 (minor 4): the policy is still read and compared; only matching objects leave it unchanged.
  const intact = fakeCluster({ objects: [...liveProfile({ samba: true }), modelPolicy(), modelBinding()] });
  const record = applyFoundationRuntimeRbac(same, { kubectl: serverView(intact), sleep: () => {} });
  assert.equal(record.decision, 'unchanged');
  assert.equal(intact.writes().length, 0);
  const edited = decoupledBundle(); edited.resources[2].spec.validations[0].expression += ' && true';
  assert.equal(planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: JSON.stringify(edited), baselineRevision: OLD_REVISION,
    baselineBundle: decoupledText() }).reason, 'profile-changed');
});

// Review 2026-10-19 (minor 1 and 3): status.typeChecking from one read is not enforcement on every API server (kind: up
// to about 1.1 s later, RKE2 has three). The RBAC is widened only after dry runs as the runtime identity are denied by
// the policy several times in a row; an API server that keeps admitting stops the step with the RBAC untouched.
test('D-C2: the RBAC is widened only after the API servers deny an unapproved name several times in a row', () => {
  const late = fakeCluster({ objects: liveProfile({ samba: true }), admitProbes: 3 });
  const record = applyFoundationRuntimeRbac(decoupledPlan(), { kubectl: serverView(late), sleep: () => {} });
  assert.equal(record.decision, 'applied');
  assert.deepEqual(record.admissionProbe, { probe: 'denied', attempts: 8 });
  const never = fakeCluster({ objects: liveProfile({ samba: true }), admitProbes: 1000 });
  assert.throws(() => applyFoundationRuntimeRbac(decoupledPlan(), { kubectl: serverView(never), sleep: () => {} }),
    (error) => /not proven enforced/.test(error.message) && error.prerequisiteRecord?.decision === 'changed-unverified');
  assert.equal(never.writes().length, 1, 'only the policy was written');
  assert.deepEqual(never.store.get('ClusterRole//opensphere-foundation-runtime').rules,
    liveProfile({ samba: true }).find((d) => d.kind === 'ClusterRole' && d.metadata.name === 'opensphere-foundation-runtime').rules);
  // RBAC that already refuses the runtime identity cannot show the policy: Setup waits the measured settle time instead.
  const slept = [];
  const forbidden = fakeCluster({ objects: liveProfile({ samba: true }),
    probeError: 'Error from server (Forbidden): foundationmodels.foundation.opensphere.io is forbidden: User "system:serviceaccount:opensphere-console:opensphere-foundation-runtime" cannot create resource "foundationmodels"' });
  assert.equal(applyFoundationRuntimeRbac(decoupledPlan(), { kubectl: serverView(forbidden), sleep: (ms) => slept.push(ms) }).admissionProbe.probe, 'rbac-forbidden');
  assert.ok(slept.includes(3000));
});

// Review 2026-10-19 (minor 3): a Setup that knew only v1 would apply the name-free RBAC before the policy. The bundle that
// carries the policy is v2; this Setup accepts v1 and v2 and refuses the policy or name-free RBAC in a v1 bundle.
test('D-C2: the name policy and name-free RBAC come only in a v2 bundle', () => {
  assert.equal(decoupledPlan().changed, true);
  const v1 = decoupledBundle(); v1.schema = 'opensphere.foundation-bootstrap/v1';
  assert.throws(() => planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: JSON.stringify(v1), baselineRevision: OLD_REVISION,
    baselineBundle: bundleText({ samba: true }) }), /is not opensphere.foundation-bootstrap\/v2/);
  const v3 = decoupledBundle(); v3.schema = 'opensphere.foundation-bootstrap/v3';
  assert.throws(() => planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: JSON.stringify(v3) }), /unsupported contract/);
  // An older v1 bundle without the policy keeps working (rollback baseline, older Console).
  assert.equal(forwardPlan().admission.length, 0);
});

// Review 2026-10-19 (minor 4): with an unchanged bundle the policy was neither read nor restored. A deleted or edited
// policy is now applied again, type-checked and proven before the release continues; the RBAC is not rewritten.
test('D-C2: an unchanged bundle restores a deleted or edited name policy before anything else', () => {
  const same = planFoundationRuntimeRbac({ sourceRevision: NEW_REVISION, bundle: decoupledText(), baselineRevision: OLD_REVISION,
    baselineBundle: decoupledText(), controllerManifest: decoupledManifest() });
  const edited = modelPolicy(); edited.spec.failurePolicy = 'Ignore';
  for (const [label, objects] of [['deleted', [modelBinding()]], ['edited', [edited, modelBinding()]]]) {
    const cluster = fakeCluster({ objects: [...liveProfile({ samba: true }), ...objects] });
    const record = applyFoundationRuntimeRbac(same, { kubectl: serverView(cluster), sleep: () => {} });
    assert.equal(record.decision, 'admission-restored', label);
    assert.deepEqual(record.restored, ['ValidatingAdmissionPolicy/opensphere-foundation-model-writer'], label);
    assert.equal(record.admissionProbe.probe, 'denied', label);
    assert.equal(cluster.writes().length, 1, `${label}: only the policy was written`);
    assert.deepEqual(JSON.parse(cluster.writes()[0].input).items.map((d) => d.kind), ['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding']);
    assert.match(describeComponentRuntimePrerequisite(record), /FoundationModel 이름 정책이 바뀌었거나 없어 다시 적용/);
  }
});
