import test from 'node:test';
import assert from 'node:assert/strict';
import operatorArtifact from '../src/console-db-cnpg-operator-artifact.json' with { type: 'json' };
import images from '../src/console-db-cnpg-images.json' with { type: 'json' };
import {
  CLUSTER_NAME, CUTOVER_CONFIGMAP, CUTOVER_LOCK, DATA_NAMESPACE, FENCE_NAME, INSTANCE_ROLE_RULES, OPERATOR_NAMESPACE, OPERATOR_SECRET_TYPES, OPERATOR_USER,
  PRIMARY_SELECTOR, SETUP_OWNED_NAMES,
  assertConsoleDbClusterHealthy, assertReleaseFitsLayout, classifyConsoleDataLayout, consoleDbImages, consoleDbSql, consoleDbTarget,
  imageForms, installerSupportsCnpgLayout, isRetainedLegacyObject, kubernetesApiPeers, renderConsoleDbCluster, renderFence,
  renderNetworkPolicies, renderOperatorObjects, verifyOperatorArtifact, watchedNamespaceRules,
} from '../src/console-db-cnpg.mjs';
import { coreRolloutsForLayout, consoleReleaseDataLayout, pruneReleaseResources, CORE_ROLLOUTS } from '../src/bootstrap.mjs';

// R2-C2 (plan 2026-10-24 §4.1 "CNPG", user confirmation 2026-10-27): the CloudNativePG operator as a Setup base
// component, its admission fence, the M1/M2 NetworkPolicies of the vulnerability triage and the Console DB Cluster.
const api = {
  egress: [{ to: [{ ipBlock: { cidr: '10.43.0.1/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    { to: [{ ipBlock: { cidr: '10.10.1.31/32' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
    { to: [{ ipBlock: { cidr: '10.10.1.32/32' } }], ports: [{ protocol: 'TCP', port: 6443 }] }],
  sources: ['10.10.1.31/32', '10.10.1.32/32'], ports: [443, 6443],
};

test('images: tag and digest from the one images file, PostgreSQL 17 only (triage M5)', () => {
  assert.deepEqual(consoleDbImages(), { operator: images.operator, postgres: images.postgres });
  assert.equal(images.operator, 'ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1@sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07');
  assert.equal(images.postgres, 'ghcr.io/cloudnative-pg/postgresql:17.11-202610120828-standard-trixie@sha256:b3d52e61dc97095efbb603dcb38178491ab3d4b99753cfe6e642ac57366469c1');
  assert.throws(() => consoleDbImages({ ...images, operator: 'ghcr.io/cloudnative-pg/cloudnative-pg@sha256:' + 'a'.repeat(64) }), /tag and digest/);
  assert.throws(() => consoleDbImages({ ...images, postgres: 'ghcr.io/cloudnative-pg/postgresql:17.11-202610120828-standard-trixie' }), /tag and digest/);
  assert.throws(() => consoleDbImages({ ...images, postgres: images.postgres.replace(':17.11', ':18.1') }), /tag and digest/);
  // A digest-preserving OpenSphere mirror is accepted (option A of the image-integrity break), nothing else.
  const mirror = { operator: images.operator.replace('ghcr.io/', 'ghcr.io/opensphere-platform/mirror/'), postgres: images.postgres.replace('ghcr.io/', 'ghcr.io/opensphere-platform/mirror/') };
  assert.deepEqual(consoleDbImages(mirror), mirror);
  assert.throws(() => consoleDbImages({ ...images, postgres: images.postgres.replace('ghcr.io/cloudnative-pg/', 'docker.io/evil/') }), /tag and digest/);
  assert.deepEqual(imageForms(images.operator), [images.operator, `ghcr.io/cloudnative-pg/cloudnative-pg@${images.operator.split('@')[1]}`]);
});

test('the chart render is the pinned upstream bytes', () => {
  assert.equal(verifyOperatorArtifact().length, 24);
  assert.equal(operatorArtifact.source.sha256, 'b53d3991fe84bcf38767e7702cae78666265427a127a26fff168ab4207d2b1df');
  assert.throws(() => verifyOperatorArtifact({ ...operatorArtifact, yaml: operatorArtifact.yaml.replace('- get\n', '- "*"\n') }), { code: 'UNTRUSTED_PROFILE' });
});

test('operator: own namespace, two replicas, watches only the Console data namespace, pinned image, least privilege', () => {
  const r = renderOperatorObjects({ api, cilium: true });
  const ns = r.fence.find((d) => d.kind === 'Namespace');
  assert.equal(ns.metadata.name, OPERATOR_NAMESPACE);
  assert.equal(ns.metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted');
  const deploy = r.operator.find((d) => d.kind === 'Deployment');
  assert.equal(deploy.metadata.namespace, OPERATOR_NAMESPACE);
  assert.equal(deploy.spec.replicas, 2);
  assert.ok(deploy.spec.template.spec.containers[0].args.includes('--leader-elect'));
  const env = Object.fromEntries(deploy.spec.template.spec.containers[0].env.filter((e) => 'value' in e).map((e) => [e.name, e.value]));
  assert.equal(env.WATCH_NAMESPACE, DATA_NAMESPACE);
  assert.equal(env.OPERATOR_IMAGE_NAME, images.operator);
  assert.equal(deploy.spec.template.spec.containers[0].image, images.operator);
  assert.equal(deploy.spec.template.spec.topologySpreadConstraints[0].whenUnsatisfiable, 'DoNotSchedule');
  assert.equal(r.operator.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'cnpg-controller-manager-config').data.WATCH_NAMESPACE, DATA_NAMESPACE);
  // Cluster scope: nodes read, the two webhook configurations by name, image catalogs read. No Pods or Secrets.
  const clusterRole = r.operator.find((d) => d.kind === 'ClusterRole');
  assert.deepEqual(clusterRole.rules.map((x) => x.resources.join('+')), ['nodes', 'mutatingwebhookconfigurations+validatingwebhookconfigurations', 'clusterimagecatalogs']);
  assert.deepEqual(clusterRole.rules[1].resourceNames, ['cnpg-mutating-webhook-configuration', 'cnpg-validating-webhook-configuration']);
  assert.deepEqual(r.dropped, ['cnpg-cloudnative-pg-view', 'cnpg-cloudnative-pg-edit']);
  assert.equal(r.operator.filter((d) => d.kind === 'ClusterRole').length, 1);
  // The namespaced rules are bound only in the watched namespace; unused writes are cut back to reads.
  const role = r.operator.find((d) => d.kind === 'Role' && d.metadata.namespace === DATA_NAMESPACE);
  for (const resource of ['deployments', 'podmonitors', 'volumesnapshots']) {
    assert.deepEqual(role.rules.find((x) => x.resources.includes(resource)).verbs, ['get', 'list', 'watch'], resource);
  }
  assert.ok(r.operator.every((d) => !d.metadata.labels['helm.sh/chart'] && d.metadata.labels['app.kubernetes.io/managed-by'] === 'opensphere-setup'));
  for (const d of r.operator.filter((x) => ['ServiceAccount', 'ConfigMap', 'Service', 'Deployment'].includes(x.kind))) assert.equal(d.metadata.namespace, OPERATOR_NAMESPACE);
  for (const w of r.operator.find((d) => d.kind === 'ValidatingWebhookConfiguration').webhooks) assert.equal(w.clientConfig.service.namespace, OPERATOR_NAMESPACE);
});

test('watched-namespace rules: only the three unused write sets change', () => {
  const chart = verifyOperatorArtifact().find((d) => d.kind === 'Role').rules;
  const trimmed = watchedNamespaceRules(chart);
  const changed = trimmed.filter((rule, i) => JSON.stringify(rule) !== JSON.stringify(chart[i]));
  assert.deepEqual(changed.map((x) => x.resources[0]).sort(), ['deployments', 'podmonitors', 'volumesnapshots']);
});

test('NetworkPolicies: M1 operator ingress 9443 from the API server and 8080 from Prometheus only; M2 instance policy', () => {
  const policies = renderNetworkPolicies({ api, cilium: true });
  const op = policies.find((p) => p.kind === 'NetworkPolicy' && p.metadata.name === 'opensphere-cnpg-operator');
  assert.deepEqual(op.spec.ingress.map((r) => r.ports.map((p) => p.port)), [[9443], [8080]]);
  assert.deepEqual(op.spec.ingress[0].from, [{ ipBlock: { cidr: '10.10.1.31/32' } }, { ipBlock: { cidr: '10.10.1.32/32' } }]);
  assert.deepEqual(op.spec.ingress[1].from[0].podSelector.matchLabels, { 'app.kubernetes.io/name': 'prometheus' });
  assert.deepEqual(op.spec.ingress[1].from[0].namespaceSelector.matchLabels, { 'kubernetes.io/metadata.name': 'monitoring' });
  // Egress: API (VIP and endpoints) and the instances' 8000/5432 only. No DNS, nothing else.
  assert.equal(op.spec.egress.length, 4);
  assert.deepEqual(op.spec.egress.at(-1).ports.map((p) => p.port), [8000, 5432]);
  assert.ok(policies.some((p) => p.metadata.name === 'opensphere-cnpg-default-deny' && p.spec.policyTypes.join() === 'Ingress,Egress'));
  const inst = policies.find((p) => p.kind === 'NetworkPolicy' && p.metadata.name === `${CLUSTER_NAME}-cnpg`);
  assert.equal(inst.metadata.namespace, DATA_NAMESPACE);
  assert.deepEqual(inst.spec.ingress.map((r) => r.ports.map((p) => p.port)), [[8000, 5432], [8000, 5432]]);
  // Same-named CiliumNetworkPolicies with the kube-apiserver entity, only where Cilium serves them.
  const cnp = policies.filter((p) => p.kind === 'CiliumNetworkPolicy');
  assert.deepEqual(cnp.map((p) => `${p.metadata.namespace}/${p.metadata.name}`), [`${OPERATOR_NAMESPACE}/opensphere-cnpg-operator`, `${DATA_NAMESPACE}/${CLUSTER_NAME}-cnpg`]);
  assert.deepEqual(cnp[0].spec.ingress, [{ fromEntities: ['kube-apiserver'], toPorts: [{ ports: [{ port: '9443', protocol: 'TCP' }] }] }]);
  assert.equal(renderNetworkPolicies({ api, cilium: false }).filter((p) => p.kind === 'CiliumNetworkPolicy').length, 0);
});

test('API peers: webhook sources exclude the Service VIP and never widen to 0/0', () => {
  const service = { metadata: { name: 'kubernetes', namespace: 'default' }, spec: { clusterIP: '10.43.0.1', clusterIPs: ['10.43.0.1'], ports: [{ name: 'https', port: 443 }] } };
  const slices = { items: [{ metadata: { namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } }, addressType: 'IPv4',
    ports: [{ name: 'https', port: 6443 }], endpoints: [{ addresses: ['10.10.1.31'] }, { addresses: ['10.10.1.33'] }] }] };
  const peers = kubernetesApiPeers(service, slices);
  assert.deepEqual(peers.sources, ['10.10.1.31/32', '10.10.1.33/32']);
  assert.deepEqual(peers.ports, [443, 6443]);
  assert.throws(() => kubernetesApiPeers(service, { items: [] }));
});

test('fence: bound to the operator account only, fail-closed, deny by default, closed list of kinds', () => {
  const [policy, binding] = renderFence();
  assert.equal(policy.metadata.name, FENCE_NAME);
  assert.equal(policy.spec.failurePolicy, 'Fail');
  assert.deepEqual(policy.spec.matchConditions, [{ name: 'cnpg-operator', expression: `request.userInfo.username == '${OPERATOR_USER}'` }]);
  assert.deepEqual(policy.spec.matchConstraints.namespaceSelector, { matchLabels: { 'kubernetes.io/metadata.name': DATA_NAMESPACE } });
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations, ['CREATE', 'UPDATE', 'DELETE', 'CONNECT']);
  assert.deepEqual(binding.spec, { policyName: FENCE_NAME, validationActions: ['Deny'] });
  assert.deepEqual(renderFence({ mode: 'warn' })[1].spec.validationActions, ['Warn', 'Audit']);
  assert.throws(() => renderFence({ mode: 'off' }));
  const text = JSON.stringify(policy.spec);
  for (const image of [...imageForms(images.operator), ...imageForms(images.postgres)]) assert.ok(text.includes(image), image);
  // The Setup-owned Secrets, the webhook CA-bundle-only rule, no Cluster create/delete or spec change.
  assert.match(text, /opensphere-console-db-supabase-admin', 'opensphere-console-db-import-source'/);
  assert.match(text, /cnpg-mutating-webhook-configuration/);
  assert.match(text, /object.spec == oldObject.spec/);
  assert.doesNotMatch(text, /'deployments'/, 'Deployments are not in the allowed list');
  for (const v of policy.spec.validations) assert.ok(v.message && v.expression.length < 5000);
});

test('fence (review finding 4): Setup-owned names, Secret types and the instance Role are closed lists', () => {
  const [policy] = renderFence();
  const rule = (needle) => policy.spec.validations.find((v) => v.message.includes(needle))?.expression;
  // (a) the checkpoint ConfigMap and the run lock match the Cluster's name pattern; they are refused by name, for
  // every kind, together with the two Setup Secrets.
  assert.deepEqual(SETUP_OWNED_NAMES, [`${CLUSTER_NAME}-supabase-admin`, `${CLUSTER_NAME}-import-source`, CUTOVER_CONFIGMAP]);
  assert.equal(CUTOVER_LOCK, CUTOVER_CONFIGMAP);
  assert.equal(rule('Setup-owned'), `variables.ns == '' || !(variables.name in ['${SETUP_OWNED_NAMES.join("', '")}'])`);
  // (b) only the Secret types CNPG writes; never a service-account token.
  assert.deepEqual(OPERATOR_SECRET_TYPES, ['Opaque', 'kubernetes.io/tls', 'kubernetes.io/basic-auth']);
  assert.ok(rule('Opaque, TLS and basic-auth').includes("(has(object.type) ? object.type : 'Opaque') in ['Opaque', 'kubernetes.io/tls', 'kubernetes.io/basic-auth']"));
  assert.ok(!JSON.stringify(policy.spec).includes('service-account-token'));
  // (c) the instance Role: exactly the table of what CNPG 1.30.1 renders, no delete on clusters, named objects.
  const table = policy.spec.variables.find((v) => v.name === 'instanceRole').expression;
  for (const [key, verbs] of Object.entries(INSTANCE_ROLE_RULES)) assert.ok(table.includes(`'${key}': ['${verbs.join("', '")}']`), key);
  assert.ok(!INSTANCE_ROLE_RULES['postgresql.cnpg.io/clusters'].includes('delete'));
  assert.ok(Object.values(INSTANCE_ROLE_RULES).every((verbs) => !verbs.some((v) => ['*', 'escalate', 'bind', 'impersonate', 'deletecollection'].includes(v))));
  const roles = rule('instance Role may grant');
  assert.ok(roles.includes("(g + '/' + x) in variables.instanceRole && r.verbs.all(v, v in variables.instanceRole[g + '/' + x])"));
  assert.ok(roles.includes(`n != '${CUTOVER_CONFIGMAP}'`));
  // Pods may not mount the checkpoint either.
  assert.ok(rule('only the pinned images').includes(`v.configMap.name != '${CUTOVER_CONFIGMAP}'`));
});

test('Console DB Cluster: 3 instances, sync any 1 preferred, required anti-affinity, ICU en-US, import as measured', () => {
  const c = renderConsoleDbCluster({ storageClass: 'longhorn' });
  assert.equal(c.metadata.namespace, DATA_NAMESPACE);
  assert.equal(c.spec.instances, 3);
  assert.equal(c.spec.imageName, images.postgres);
  assert.equal(c.spec.imagePullSecrets, undefined, 'public CNPG images need no pull Secret');
  assert.deepEqual(c.spec.postgresql.synchronous, { method: 'any', number: 1, dataDurability: 'preferred' });
  assert.deepEqual(c.spec.affinity, { enablePodAntiAffinity: true, podAntiAffinityType: 'required', topologyKey: 'kubernetes.io/hostname' });
  assert.deepEqual(c.spec.storage, { size: '20Gi', storageClass: 'longhorn' });
  assert.deepEqual(c.spec.inheritedMetadata.labels, { app: 'opensphere-supabase-postgres', 'opensphere.io/supabase-component': 'data-identity' });
  const init = c.spec.bootstrap.initdb;
  assert.deepEqual([init.localeProvider, init.icuLocale, init.localeCollate], ['icu', 'en-US', 'en_US.UTF-8']);
  assert.match(init.postInitSQL[0], /^CREATE ROLE supabase_admin WITH SUPERUSER/);
  assert.deepEqual(init.import.pgDumpExtraOptions, ['--exclude-extension=supabase_vault']);
  assert.equal(c.spec.externalClusters[0].connectionParameters.host, 'opensphere-supabase-postgres-legacy.opensphere-console-data.svc.cluster.local');
  assert.equal(c.spec.managed.roles[0].superuser, true);
  assert.equal(c.spec.enableSuperuserAccess, false);
  assert.throws(() => renderConsoleDbCluster({}), /StorageClass/);
});

test('layout: StatefulSet, CloudNativePG, or a cutover in progress; anything else is refused', () => {
  const svc = (selector, targetPort) => ({ spec: { selector, ports: [{ port: 5432, targetPort }] } });
  const cm = (state) => ({ data: { 'state.json': JSON.stringify({ state }) } });
  assert.equal(classifyConsoleDataLayout(null, null).layout, 'statefulset');
  assert.equal(classifyConsoleDataLayout(svc({ app: 'opensphere-supabase-postgres' }, 'postgres'), null).layout, 'statefulset');
  assert.equal(classifyConsoleDataLayout(svc({ ...PRIMARY_SELECTOR }, 5432), cm('Completed')).layout, 'cnpg');
  assert.equal(classifyConsoleDataLayout(svc({ ...PRIMARY_SELECTOR }, 5432), cm('Switched')).layout, 'cutover');
  assert.equal(classifyConsoleDataLayout(svc({ app: 'opensphere-supabase-postgres' }, 'postgres'), cm('InProgress')).layout, 'cutover');
  assert.equal(classifyConsoleDataLayout(svc({ app: 'opensphere-supabase-postgres' }, 'postgres'), cm('RolledBack')).layout, 'statefulset');
  // Review finding 1: a rollback that has not finished blocks Setup like a cutover.
  assert.equal(classifyConsoleDataLayout(svc({ app: 'opensphere-supabase-postgres' }, 'postgres'), cm('RollingBack')).layout, 'cutover');
  assert.equal(classifyConsoleDataLayout(svc({ ...PRIMARY_SELECTOR }, 5432), cm('RollingBack')).layout, 'cutover');
  assert.throws(() => classifyConsoleDataLayout(svc({ ...PRIMARY_SELECTOR }, 'postgresql'), null), /neither/);
  assert.throws(() => classifyConsoleDataLayout(svc({ app: 'x' }, 5432), null), /neither/);
  assert.throws(() => classifyConsoleDataLayout(svc({ app: 'opensphere-supabase-postgres' }, 'postgres'), cm('Completed')), /StatefulSet/);
  assert.throws(() => classifyConsoleDataLayout(null, { data: { 'state.json': 'nope' } }), /unreadable/);
});

function fakeKube({ layout = 'statefulset', pods = [], cluster = null } = {}) {
  const calls = [];
  const k = (args, options) => {
    calls.push({ args, input: options?.input });
    if (args.includes('service') && args.includes('get')) {
      return JSON.stringify(layout === 'cnpg' ? { spec: { selector: { ...PRIMARY_SELECTOR }, ports: [{ port: 5432, targetPort: 5432 }] } }
        : { spec: { selector: { app: 'opensphere-supabase-postgres' }, ports: [{ port: 5432, targetPort: 'postgres' }] } });
    }
    if (args.includes('configmap')) return '';
    if (args.includes('pods')) return JSON.stringify({ items: pods });
    if (args.includes('clusters.postgresql.cnpg.io')) return JSON.stringify(cluster);
    if (args.includes('exec')) return 'out';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { k, calls };
}
const ready = (name) => ({ metadata: { name }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } });

test('executor: the StatefulSet path is unchanged; the CNPG path is the primary socket as postgres with SET LOCAL ROLE', () => {
  const old = fakeKube({ pods: [ready('opensphere-supabase-postgres-0')] });
  const t = consoleDbTarget(old.k, 'Migration');
  assert.deepEqual(t, { layout: 'statefulset', pod: 'opensphere-supabase-postgres-0', container: 'postgres' });
  consoleDbSql(old.k, t, 'SELECT 1;', { transaction: true });
  assert.deepEqual(old.calls.at(-1).args, ['-n', DATA_NAMESPACE, 'exec', '-i', 'opensphere-supabase-postgres-0', '--', 'sh', '-ec',
    'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction']);
  assert.equal(old.calls.at(-1).input, 'SELECT 1;');
  assert.throws(() => consoleDbTarget(fakeKube({ pods: [] }).k, 'Migration'), /exactly one Ready Supabase PostgreSQL pod/);

  const cnpg = fakeKube({ layout: 'cnpg', pods: [ready('opensphere-console-db-2')], cluster: { status: { currentPrimary: 'opensphere-console-db-2', targetPrimary: 'opensphere-console-db-2' } } });
  const p = consoleDbTarget(cnpg.k, 'Migration');
  assert.equal(p.pod, 'opensphere-console-db-2');
  assert.ok(cnpg.calls.some((c) => c.args.includes(`cnpg.io/cluster=${CLUSTER_NAME},cnpg.io/instanceRole=primary`)));
  consoleDbSql(cnpg.k, p, 'CREATE TABLE x();', { transaction: true });
  assert.deepEqual(cnpg.calls.at(-1).args, ['-n', DATA_NAMESPACE, 'exec', '-i', 'opensphere-console-db-2', '-c', 'postgres', '--',
    'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '--single-transaction']);
  assert.equal(cnpg.calls.at(-1).input, 'SET LOCAL ROLE supabase_admin;\nCREATE TABLE x();');
  consoleDbSql(cnpg.k, p, 'SELECT 1;');
  assert.equal(cnpg.calls.at(-1).input, 'SET ROLE supabase_admin;\nSELECT 1;');
  assert.ok(cnpg.calls.at(-1).args.includes('-tA'));
  // A switchover in flight, or a cutover, refuses.
  const moving = fakeKube({ layout: 'cnpg', pods: [ready('opensphere-console-db-2')], cluster: { status: { currentPrimary: 'opensphere-console-db-2', targetPrimary: 'opensphere-console-db-3' } } });
  assert.throws(() => consoleDbTarget(moving.k, 'Migration'), /primary is changing/);
  assert.throws(() => consoleDbTarget(old.k, 'Migration', { layout: 'cutover' }), { code: 'CONSOLE_DB_CUTOVER' });
});

const CNPG_INSTALLER = "param(\n  [string]$ConsoleApiImage,\n  [ValidateSet('statefulset','cnpg')][string]$ConsoleDataLayout = 'statefulset'\n)\n$ErrorActionPreference = 'Stop'\n";
const OLD_INSTALLER = "param(\n  [string]$ConsoleApiImage\n)\n$ErrorActionPreference = 'Stop'\n";
test('a Console release must declare the CNPG layout once the Console DB is on CloudNativePG', () => {
  assert.equal(installerSupportsCnpgLayout(CNPG_INSTALLER), true);
  assert.equal(installerSupportsCnpgLayout(OLD_INSTALLER), false);
  assert.equal(installerSupportsCnpgLayout(`${OLD_INSTALLER}# [ValidateSet('statefulset','cnpg')][string]$ConsoleDataLayout\n`), false, 'outside the param block does not count');
  assert.deepEqual(assertReleaseFitsLayout('statefulset', { label: 'x', installerSource: OLD_INSTALLER }), { layoutArguments: [] });
  assert.deepEqual(assertReleaseFitsLayout('cnpg', { label: 'x', installerSource: CNPG_INSTALLER }), { layoutArguments: ['-ConsoleDataLayout', 'cnpg'] });
  assert.throws(() => assertReleaseFitsLayout('cnpg', { label: 'Console release 1', installerSource: OLD_INSTALLER }), { code: 'CONSOLE_DB_LAYOUT_UNSUPPORTED' });
  assert.throws(() => assertReleaseFitsLayout('cutover', { label: 'x', installerSource: CNPG_INSTALLER }), { code: 'CONSOLE_DB_CUTOVER' });
  const artifacts = (api, native) => [{ path: 'scripts/Install-ConsoleApiRuntime.ps1', contents: api }, { path: 'scripts/Install-ConsoleNativeRuntime.ps1', contents: native }];
  const cnpg = () => ({ layout: 'cnpg' });
  assert.deepEqual(consoleReleaseDataLayout({ sourceRevision: 'a' }, true, artifacts(CNPG_INSTALLER, CNPG_INSTALLER), cnpg),
    { layout: 'cnpg', layoutArguments: ['-ConsoleDataLayout', 'cnpg'], nativeLayoutArguments: ['-ConsoleDataLayout', 'cnpg'] });
  assert.throws(() => consoleReleaseDataLayout({ sourceRevision: 'a' }, true, artifacts(CNPG_INSTALLER, OLD_INSTALLER), cnpg), /predates/);
  assert.throws(() => consoleReleaseDataLayout({ sourceRevision: 'a' }, false, [], cnpg), /legacy Console release/);
  assert.deepEqual(consoleReleaseDataLayout({ sourceRevision: 'a' }, true, artifacts(OLD_INSTALLER, OLD_INSTALLER), () => ({ layout: 'statefulset' })).layoutArguments, []);
});

test('rollouts: the StatefulSet rollout gives way to the Cluster on CNPG; a cutover refuses', () => {
  assert.ok(coreRolloutsForLayout(CORE_ROLLOUTS, 'statefulset').some(([, r]) => r === 'statefulset/opensphere-supabase-postgres'));
  assert.ok(!coreRolloutsForLayout(CORE_ROLLOUTS, 'cnpg').some(([, r]) => r === 'statefulset/opensphere-supabase-postgres'));
  assert.equal(coreRolloutsForLayout(CORE_ROLLOUTS, 'cnpg').length, CORE_ROLLOUTS.length - 1);
  assert.throws(() => coreRolloutsForLayout(CORE_ROLLOUTS, 'cutover'), { code: 'CONSOLE_DB_CUTOVER' });
});

test('a release prune never deletes the retired StatefulSet, its PVC or ServiceAccount', () => {
  const legacy = [
    { apiVersion: 'apps/v1', kind: 'StatefulSet', namespace: DATA_NAMESPACE, name: 'opensphere-supabase-postgres' },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', namespace: DATA_NAMESPACE, name: 'opensphere-supabase-postgres-data' },
    { apiVersion: 'v1', kind: 'ServiceAccount', namespace: DATA_NAMESPACE, name: 'opensphere-supabase-postgres' },
  ];
  const other = { apiVersion: 'v1', kind: 'Service', namespace: DATA_NAMESPACE, name: 'gone' };
  for (const r of legacy) assert.equal(isRetainedLegacyObject(r), true);
  const deleted = [];
  const retained = pruneReleaseResources([...legacy, other], [], (args) => { deleted.push(args.join(' ')); return ''; });
  assert.deepEqual(retained, legacy);
  assert.deepEqual(deleted, [`-n ${DATA_NAMESPACE} delete Service/gone --ignore-not-found --wait=true`]);
});

test('steady-state Cluster check', () => {
  const cluster = { spec: renderConsoleDbCluster({ storageClass: 'longhorn' }).spec, status: { readyInstances: 3, currentPrimary: 'a', targetPrimary: 'a', phase: 'Cluster in healthy state' } };
  assert.equal(assertConsoleDbClusterHealthy(cluster, { storageClass: 'longhorn' }).readyInstances, 3);
  assert.throws(() => assertConsoleDbClusterHealthy({ ...cluster, status: { ...cluster.status, readyInstances: 2 } }), /ready 2\/3/);
  assert.throws(() => assertConsoleDbClusterHealthy({ ...cluster, spec: { ...cluster.spec, imageName: 'other' } }), /image/);
  assert.throws(() => assertConsoleDbClusterHealthy(cluster, { storageClass: 'ceph' }), /StorageClass/);
});
