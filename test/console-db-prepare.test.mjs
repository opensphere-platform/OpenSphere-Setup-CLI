import test from 'node:test';
import assert from 'node:assert/strict';
import { CLUSTER_NAME, DATA_NAMESPACE, FENCE_NAME, OPERATOR_NAMESPACE, clusterReferenceViolations, instanceRoleViolations, renderConsoleDbCluster } from '../src/console-db-cnpg.mjs';
import { prepareConsoleDb } from '../src/console-db-prepare.mjs';

// Second review of Setup PR #64, items 3 and 7: what prepare-console-db (and so Setup upgrade) does when the fence
// could stall the operator, and how a warn-mode fence is reported.
// The instance Role CloudNativePG 1.30.1 wrote in the kind lab (review-fixes/lab/10-instance-role.json).
const LAB_ROLE = [
  { apiGroups: [''], resourceNames: ['cnpg-default-monitoring', 'opensphere-console-db'], resources: ['configmaps'], verbs: ['get', 'watch'] },
  { apiGroups: [''], resourceNames: ['opensphere-console-db-app', 'opensphere-console-db-ca', 'opensphere-console-db-import-source', 'opensphere-console-db-replication',
    'opensphere-console-db-server', 'opensphere-console-db-supabase-admin', 'opensphere-console-db-superuser'], resources: ['secrets'], verbs: ['get', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resourceNames: ['opensphere-console-db'], resources: ['clusters'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resourceNames: ['opensphere-console-db'], resources: ['clusters/status'], verbs: ['get', 'patch', 'update', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['backups'], verbs: ['list', 'get', 'delete'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['backups/status'], verbs: ['get', 'patch', 'update'] },
  { apiGroups: [''], resources: ['events'], verbs: ['create', 'patch'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['databases'], verbs: ['get', 'update', 'list', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['databases/status'], verbs: ['get', 'patch', 'update'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['publications'], verbs: ['get', 'update', 'list', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['publications/status'], verbs: ['get', 'patch', 'update'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['subscriptions'], verbs: ['get', 'update', 'list', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['subscriptions/status'], verbs: ['get', 'patch', 'update'] },
  { apiGroups: ['coordination.k8s.io'], resourceNames: ['opensphere-console-db'], resources: ['leases'], verbs: ['get', 'update'] },
  { apiGroups: ['postgresql.cnpg.io'], resourceNames: ['opensphere-console-db'], resources: ['failoverquorums'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resourceNames: ['opensphere-console-db'], resources: ['failoverquorums/status'], verbs: ['get', 'patch', 'update', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['databaseroles'], verbs: ['get', 'update', 'list', 'watch'] },
  { apiGroups: ['postgresql.cnpg.io'], resources: ['databaseroles/status'], verbs: ['get', 'patch', 'update'] },
];

test('the measured table admits the Role CNPG 1.30.1 wrote, and refuses what the fence refuses', () => {
  assert.deepEqual(instanceRoleViolations(LAB_ROLE), []);
  const withRule = (rule) => instanceRoleViolations([...LAB_ROLE, rule]);
  assert.equal(withRule({ apiGroups: ['postgresql.cnpg.io'], resources: ['clusters'], verbs: ['delete'], resourceNames: [CLUSTER_NAME] }).length, 1);
  assert.equal(withRule({ apiGroups: [''], resources: ['secrets'], verbs: ['get'], resourceNames: ['s3-creds'] }).length, 1, 'a future backup credential');
  assert.equal(withRule({ apiGroups: [''], resources: ['configmaps'], verbs: ['get'], resourceNames: [`${CLUSTER_NAME}-cutover`] }).length, 1);
  assert.equal(withRule({ apiGroups: [''], resources: ['pods'], verbs: ['get'] }).length, 1);
  assert.equal(withRule({ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }).length, 1, 'unnamed');
});

test('every Secret and ConfigMap the Cluster references is named opensphere-console-db-*', () => {
  const spec = renderConsoleDbCluster({ storageClass: 'longhorn' }).spec;
  assert.deepEqual(clusterReferenceViolations(spec), []);
  const bad = structuredClone(spec);
  bad.backup = { barmanObjectStore: { s3Credentials: { accessKeyId: { name: 's3-creds', key: 'id' }, secretAccessKey: { name: `${CLUSTER_NAME}-s3`, key: 'k' } } } };
  bad.certificates = { serverTLSSecret: 'x' };
  bad.monitoring = { customQueriesConfigMap: [{ name: 'queries', key: 'q' }] };
  bad.externalClusters[0].sslKey = { name: 'client-key', key: 'tls.key' };
  assert.deepEqual(clusterReferenceViolations(bad).map((v) => v.split(':')[0]).sort(),
    ['backup.barmanObjectStore.s3Credentials.accessKeyId', 'certificates.serverTLSSecret', 'externalClusters[0].sslKey', 'monitoring.customQueriesConfigMap[0]']);
});

// A cluster that answers prepare-console-db's reads: every object as rendered, unless the test changes it.
function cluster({ binding = ['Deny'], operatorImage = null, liveCluster = null, liveRole = null } = {}) {
  const writes = [];
  const runner = (bin, args, options = {}) => {
    const a = args.slice(2);
    const text = a.join(' ');
    if (/^(apply|create|replace|patch|delete|annotate|scale)\b/.test(a[0])) { writes.push(text); return ''; }
    if (text.startsWith('get namespace kube-system')) return JSON.stringify({ metadata: { uid: 'u1' } });
    if (text.includes('configmap opensphere-installation-lock')) return JSON.stringify({ metadata: { uid: 'i1' }, data: { 'release.json': JSON.stringify({ channel: 'edge', releaseDigest: `sha256:${'a'.repeat(64)}` }), 'config.json': JSON.stringify({ consoleUrl: 'https://console.lab.test', storageClass: 'longhorn' }) } });
    if (text.startsWith(`get namespace ${DATA_NAMESPACE}`)) return `namespace/${DATA_NAMESPACE}`;
    if (text.includes('get service kubernetes')) return JSON.stringify({ metadata: { name: 'kubernetes', namespace: 'default' }, spec: { clusterIP: '10.43.0.1', clusterIPs: ['10.43.0.1'], ports: [{ name: 'https', port: 443 }] } });
    if (text.includes('get endpointslices.discovery.k8s.io')) return JSON.stringify({ items: [{ metadata: { namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } }, addressType: 'IPv4', ports: [{ name: 'https', port: 6443 }], endpoints: [{ addresses: ['10.10.1.31'] }] }] });
    if (text.includes('customresourcedefinition ciliumnetworkpolicies')) return '';
    if (text.includes(`validatingadmissionpolicybinding ${FENCE_NAME}`)) return JSON.stringify({ spec: { validationActions: binding } });
    if (text.includes('get clusters.postgresql.cnpg.io')) return liveCluster ? JSON.stringify(liveCluster) : '';
    if (text.includes(`get role ${CLUSTER_NAME}`)) return liveRole ? JSON.stringify({ rules: liveRole }) : '';
    if (a[0] === 'get' && a[1] === '-f') {
      const items = JSON.parse(options.input).items.map((d) => {
        const live = structuredClone({ ...d, metadata: { ...d.metadata, uid: 'x' } });
        if (d.kind === 'Deployment' && operatorImage) live.spec.template.spec.containers[0].image = operatorImage;
        return live;
      });
      return JSON.stringify({ kind: 'List', items });
    }
    throw new Error(`unexpected kubectl ${text}`);
  };
  return { runner, writes };
}

test('an upgrade keeps a warn fence and says so; a deny plan is Present', async () => {
  const deny = await prepareConsoleDb({ context: 'lab', runner: cluster().runner, fenceMode: 'preserve' });
  assert.equal(deny.state, 'Present');
  assert.deepEqual(deny.warnings, []);
  const warn = await prepareConsoleDb({ context: 'lab', runner: cluster({ binding: ['Warn', 'Audit'] }).runner, fenceMode: 'preserve' });
  assert.equal(warn.fenceMode, 'warn');
  assert.equal(warn.state, 'Present');
  assert.match(warn.warnings[0], /fence is in warn mode/);
});

test('a new operator image, a foreign Secret reference or a Role outside the table blocks a deny plan and apply', async () => {
  const pinnedOperator = renderConsoleDbCluster({ storageClass: 'longhorn' }).spec.imageName; // any other image will do
  const image = await prepareConsoleDb({ context: 'lab', runner: cluster({ operatorImage: pinnedOperator }).runner });
  assert.equal(image.state, 'Blocked');
  assert.equal(image.reason, 'OperatorRemeasureRequired');
  assert.match(image.message, /--operator-fence warn/);
  const viaWarn = await prepareConsoleDb({ context: 'lab', runner: cluster({ operatorImage: pinnedOperator }).runner, fenceMode: 'warn' });
  assert.notEqual(viaWarn.state, 'Blocked', 'the operator upgrade goes through warn');
  const spec = structuredClone(renderConsoleDbCluster({ storageClass: 'longhorn' }).spec);
  spec.backup = { barmanObjectStore: { s3Credentials: { accessKeyId: { name: 's3-creds', key: 'id' } } } };
  const refs = await prepareConsoleDb({ context: 'lab', runner: cluster({ liveCluster: { spec } }).runner, fenceMode: 'warn' });
  assert.equal(refs.reason, 'ClusterReferencesOutsideFence', 'refused in warn too');
  const role = [...LAB_ROLE, { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'watch'], resourceNames: ['s3-creds'] }];
  assert.equal((await prepareConsoleDb({ context: 'lab', runner: cluster({ liveRole: role }).runner })).reason, 'InstanceRoleOutsideFence');
  const warnRole = await prepareConsoleDb({ context: 'lab', runner: cluster({ liveRole: role, binding: ['Warn', 'Audit'] }).runner, fenceMode: 'preserve' });
  assert.equal(warnRole.state, 'Present');
  assert.ok(warnRole.warnings.some((w) => /differs from the measured table/.test(w)));
  const blocked = cluster({ operatorImage: pinnedOperator });
  await assert.rejects(prepareConsoleDb({ context: 'lab', runner: blocked.runner, apply: true }), { code: 'OPERATOR_REMEASURE_REQUIRED' });
  assert.deepEqual(blocked.writes, [], 'nothing was applied');
  assert.equal((await prepareConsoleDb({ context: 'lab', runner: cluster({ liveRole: LAB_ROLE }).runner })).state, 'Present');
  assert.equal(OPERATOR_NAMESPACE, 'opensphere-cnpg-system');
});
