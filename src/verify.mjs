import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { kubectl } from './process.mjs';
import {
  BOOTSTRAP_AUXILIARY_ARTIFACTS,
  BOOTSTRAP_CORE_COMPONENTS,
  releaseResponsibilityProfile,
  validateLock
} from './release.mjs';
import {
  BASELINE_OBSERVABILITY_REQUIREMENT,
  MANAGED_CLUSTER_SCOPED_RESOURCES,
  MANAGED_NAMESPACES
} from './installation-contract.mjs';
import {
  REGISTRY_PULL_SECRET,
  releaseNeedsRegistryCredentials,
  secretHasGhcrCredential
} from './registry-pull-secret.mjs';

const REQUIRED_SECRETS = Object.freeze({
  'opensphere-console-data/opensphere-supabase-secrets': [
    'anon-key', 'jwt-secret', 'postgres-password', 's3-access-key-id',
    's3-access-key-secret', 'service-role-key'
  ],
  'opensphere-console-change/opensphere-gitea-runtime': ['postgres-password', 'db-password'],
  'opensphere-console-change/opensphere-gitea-config': ['app.ini'],
  'opensphere-console-change/opensphere-gitea-signing': ['gitea-signing-key', 'gitea-signing-key.pub'],
  'opensphere-monitoring/beszel-runtime': [
    'admin-email', 'admin-password', 'reader-email', 'reader-password', 'agent-token'
  ],
  'opensphere-console/shell-tls': ['tls.crt', 'tls.key'],
  'opensphere-console/opensphere-console-api-runtime': [
    'database-url', 'session-encryption-key', 'supabase-service-role-key'
  ],
  'opensphere-console/opensphere-extension-controller-runtime': ['database-url'],
  'opensphere-console/opensphere-gitea-control-plane': [
    // The current C_API producer/consumer contract has two scoped Gitea tokens.
    // Webhook/reconciler keys belong only to the retired Backend rollback path.
    'token', 'review-token'
  ],
  'opensphere-console/opensphere-console-cli-runtime': ['jwt-secret'],
  'opensphere-console/opensphere-baseline-monitoring-reader': ['email', 'password']
});

const EXACT_SECRET_REFERENCES = Object.freeze(new Set([
  'opensphere-console-data/opensphere-supabase-secrets',
  'opensphere-monitoring/beszel-runtime',
  'opensphere-console/opensphere-console-api-runtime',
  'opensphere-console/opensphere-extension-controller-runtime',
  'opensphere-console/opensphere-baseline-monitoring-reader'
]));

const REQUIRED_PVCS = Object.freeze([
  ['opensphere-console-data', 'opensphere-supabase-postgres-data'],
  ['opensphere-console-data', 'opensphere-supabase-storage-data'],
  ['opensphere-console-change', 'opensphere-gitea-postgres-data'],
  ['opensphere-console-change', 'opensphere-gitea-data'],
  ['opensphere-monitoring', 'data-beszel-hub-0']
]);

const REQUIRED_SERVICES = Object.freeze([
  ['opensphere-console-data', 'opensphere-supabase-postgres'],
  ['opensphere-console-data', 'opensphere-supabase-auth'],
  ['opensphere-console-data', 'opensphere-supabase-rest'],
  ['opensphere-console-data', 'opensphere-supabase-storage'],
  ['opensphere-console-change', 'opensphere-gitea-postgres'],
  ['opensphere-console-change', 'opensphere-gitea'],
  ['opensphere-monitoring', 'beszel-hub'],
  ['opensphere-console', 'opensphere-console-api'],
  ['opensphere-console', 'opensphere-registry'],
  ['opensphere-console', 'opensphere-console-ext']
]);

const AUXILIARY_SERVICES = Object.freeze([
  ['opensphere-console', 'os-cli']
]);

const WORKLOADS = Object.freeze([
  { component: 'supabasePostgres', namespace: 'opensphere-console-data', kind: 'statefulset', name: 'opensphere-supabase-postgres', container: 'postgres' },
  { component: 'supabaseAuth', namespace: 'opensphere-console-data', kind: 'deployment', name: 'opensphere-supabase-auth', container: 'auth' },
  { component: 'supabaseRest', namespace: 'opensphere-console-data', kind: 'deployment', name: 'opensphere-supabase-rest', container: 'rest' },
  { component: 'supabaseStorage', namespace: 'opensphere-console-data', kind: 'deployment', name: 'opensphere-supabase-storage', container: 'storage' },
  { component: 'giteaPostgres', namespace: 'opensphere-console-change', kind: 'deployment', name: 'opensphere-gitea-postgres', container: 'postgres' },
  { component: 'gitea', namespace: 'opensphere-console-change', kind: 'deployment', name: 'opensphere-gitea', container: 'gitea' },
  { component: 'consoleApi', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console-api', container: 'api' },
  { component: 'extensionController', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-extension-controller', container: 'controller' },
  { component: 'registry', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-registry', container: 'registry' },
  { artifact: 'cliArtifacts', namespace: 'opensphere-console', kind: 'deployment', name: 'os-cli', container: 'serve' },
  { component: 'beszelHub', namespace: 'opensphere-monitoring', kind: 'statefulset', name: 'beszel-hub', container: 'hub' },
  { component: 'beszelAgent', namespace: 'opensphere-monitoring', kind: 'daemonset', name: 'beszel-agent', container: 'agent' },
  { component: 'beszelBootstrap', namespace: 'opensphere-monitoring', kind: 'job', name: 'beszel-bootstrap-v0187', container: 'configure' },
  { component: 'console', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console', container: 'shell' },
  { artifact: 'consoleIndexContent', ownerComponent: 'console', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console', container: 'console-index-content', initContainer: true }
]);

function getJson(args) {
  return JSON.parse(kubectl([...args, '-o', 'json'], { capture: true }));
}

function decodeSecret(secret, key) {
  const encoded = secret.data?.[key];
  if (!encoded) throw new Error(`Secret ${secret.metadata?.namespace}/${secret.metadata?.name} lacks ${key}`);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

export function isRetryableInstallationReadinessError(error) {
  const message = String(error?.message ?? error);
  return message.startsWith('Required Service has no ready EndpointSlice endpoint:')
    || message.startsWith('OpenSphere Pods are not Running:')
    || message.startsWith('OpenSphere Pods are not Ready:');
}

async function eventuallyReady(operation, timeoutMs = 120_000, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await operation();
    } catch (error) {
      // A release-lock/image mismatch, missing workload or malformed pull
      // configuration is deterministic. Retrying it obscures the governing
      // evidence for two minutes and delays rollback. Only rollout-readiness
      // signals are allowed to settle asynchronously.
      if (!isRetryableInstallationReadinessError(error)) throw error;
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

function verifyInstallationLock(lock, { allowLegacyComponentSet = false } = {}) {
  const configMap = getJson(['-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock']);
  const stored = validateLock(
    JSON.parse(configMap.data?.['release.json'] ?? '{}'),
    { allowLegacyComponentSet }
  );
  if (stored.releaseDigest !== lock.releaseDigest) {
    throw new Error(`Cluster release lock differs from requested lock (${stored.releaseDigest} != ${lock.releaseDigest})`);
  }
  const config = JSON.parse(configMap.data?.['config.json'] ?? '{}');
  const expectedResponsibilityBoundary = releaseResponsibilityProfile(lock.components, lock.auxiliaryArtifacts);
  const expectedObservabilityRequirement = {
    ...BASELINE_OBSERVABILITY_REQUIREMENT,
    hostAccess: [...BASELINE_OBSERVABILITY_REQUIREMENT.hostAccess]
  };
  if (config.releaseDigest !== lock.releaseDigest
      || config.channel !== lock.channel
      || JSON.stringify(config.responsibilityBoundary) !== JSON.stringify(expectedResponsibilityBoundary)
      || JSON.stringify(config.baselineObservabilityRequirement) !== JSON.stringify(expectedObservabilityRequirement)) {
    throw new Error('Installation config differs from the release lock or bootstrap responsibility contract');
  }
  const state = JSON.parse(configMap.data?.['state.json'] ?? '{}');
  const canonicalNamespaces = MANAGED_NAMESPACES;
  if (state.apiVersion !== 'bootstrap.opensphere.io/v1alpha1'
      || state.kind !== 'OpenSphereInstallationState'
      || !['Installing', 'Ready'].includes(state.phase)
      || state.releaseDigest !== lock.releaseDigest
      || JSON.stringify(state.managedNamespaces) !== JSON.stringify(canonicalNamespaces)
      || JSON.stringify(state.managedClusterScopedResources) !== JSON.stringify(MANAGED_CLUSTER_SCOPED_RESOURCES)
      || JSON.stringify(state.baselineObservabilitySecurity?.hostAccess) !== JSON.stringify(BASELINE_OBSERVABILITY_REQUIREMENT.hostAccess)
      || state.baselineObservabilitySecurity?.setupRepairsHost !== false
      || state.baselineObservabilitySecurity?.setupLowersPodSecurity !== false) {
    throw new Error('Installation lifecycle state is not verifiable for this release');
  }
  if (state.phase === 'Ready'
      && (state.verification?.evidenceConfigMap !== 'opensphere-installation-evidence'
        || !/^\d{4}-\d{2}-\d{2}T/u.test(state.verification?.verifiedAt ?? ''))) {
    throw new Error('Ready installation state lacks completed verification evidence');
  }
  return { ...config, installationState: state };
}

export function requiredSecretsForLock(_lock) {
  return { ...REQUIRED_SECRETS };
}

function verifySecrets(lock) {
  const requiredSecrets = requiredSecretsForLock(lock);
  for (const [reference, keys] of Object.entries(requiredSecrets)) {
    const [namespace, name] = reference.split('/');
    const secret = getJson(['-n', namespace, 'get', 'secret', name]);
    for (const key of keys) {
      if (!secret.data?.[key]) throw new Error(`Required Secret key is missing: ${reference}/${key}`);
    }
    if (EXACT_SECRET_REFERENCES.has(reference)) {
      const actualKeys = Object.keys(secret.data ?? {}).sort();
      const expectedKeys = [...keys].sort();
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`Required Secret has keys outside its closed contract: ${reference}`);
      }
    }
  }
  return Object.keys(requiredSecrets).length;
}

function verifyRegistryPullPath(lock) {
  const credentialRequired = releaseNeedsRegistryCredentials(lock);
  for (const namespace of MANAGED_NAMESPACES) {
    const secret = getJson(['-n', namespace, 'get', 'secret', REGISTRY_PULL_SECRET]);
    if (secret.type !== 'kubernetes.io/dockerconfigjson') {
      throw new Error(`Registry pull Secret has the wrong type: ${namespace}/${REGISTRY_PULL_SECRET}`);
    }
    if (credentialRequired && !secretHasGhcrCredential(secret)) {
      throw new Error(`Private release has no GHCR credential: ${namespace}/${REGISTRY_PULL_SECRET}`);
    }
  }
  return { secret: REGISTRY_PULL_SECRET, credentialRequired, namespaces: [...MANAGED_NAMESPACES] };
}

function verifyPersistentStorage(expectedStorageClass) {
  for (const [namespace, name] of REQUIRED_PVCS) {
    const claim = getJson(['-n', namespace, 'get', 'pvc', name]);
    if (claim.status?.phase !== 'Bound') {
      throw new Error(`PersistentVolumeClaim is not Bound: ${namespace}/${name} (${claim.status?.phase ?? 'Unknown'})`);
    }
    if (claim.spec?.storageClassName !== expectedStorageClass) {
      throw new Error(
        `PersistentVolumeClaim uses StorageClass ${claim.spec?.storageClassName ?? '<default>'}`
        + ` instead of installation StorageClass ${expectedStorageClass}: ${namespace}/${name}`
      );
    }
  }
  return REQUIRED_PVCS.length;
}

export function verifyRequiredServiceEndpoints(
  services,
  endpointSlices,
  { includeCliArtifacts = false, includeOsdst = true } = {}
) {
  const serviceByReference = new Map(services.map((service) => [
    `${service.metadata.namespace}/${service.metadata.name}`,
    service
  ]));
  const evidence = [];
  const required = includeCliArtifacts
    ? [...REQUIRED_SERVICES, ...AUXILIARY_SERVICES]
    : REQUIRED_SERVICES;
  for (const [namespace, name] of required) {
    const reference = `${namespace}/${name}`;
    if (!serviceByReference.has(reference)) throw new Error(`Required Service is missing: ${reference}`);
    const slices = endpointSlices.filter((slice) =>
      slice.metadata?.namespace === namespace
      && slice.metadata?.labels?.['kubernetes.io/service-name'] === name
    );
    const ready = slices.flatMap((slice) => slice.endpoints ?? [])
      .some((endpoint) => endpoint.conditions?.ready !== false && (endpoint.addresses?.length ?? 0) > 0);
    if (!ready) throw new Error(`Required Service has no ready EndpointSlice endpoint: ${reference}`);
    evidence.push(reference);
  }
  return evidence;
}

function verifyServiceEndpoints(lock) {
  const services = getJson(['get', 'services', '-A']).items ?? [];
  const endpointSlices = getJson(['get', 'endpointslices.discovery.k8s.io', '-A']).items ?? [];
  return verifyRequiredServiceEndpoints(services, endpointSlices, {
    includeCliArtifacts: Boolean(lock.auxiliaryArtifacts?.cliArtifacts)
  });
}

export function isRuntimeServicePod(pod) {
  if (['Succeeded', 'Failed'].includes(pod.status?.phase)) return false;
  return !(pod.metadata?.ownerReferences ?? []).some((owner) => owner.kind === 'Job');
}

export function workloadReady(resource) {
  const kind = String(resource.kind ?? '').toLowerCase();
  if (kind === 'job') {
    // Completed Jobs do not report the Deployment/StatefulSet observedGeneration
    // field. Require their own terminal success condition and successful count.
    const completions = Number(resource.spec?.completions ?? 1);
    const conditions = resource.status?.conditions ?? [];
    return Number(resource.status?.failed ?? 0) === 0
      && !conditions.some(condition => condition.type === 'Failed' && condition.status === 'True')
      && conditions.some(condition => condition.type === 'Complete' && condition.status === 'True')
      && Number(resource.status?.succeeded ?? 0) >= completions;
  }
  const generation = Number(resource.metadata?.generation ?? 0);
  if (Number(resource.status?.observedGeneration ?? 0) < generation) return false;
  if (kind === 'daemonset') {
    const desired = Number(resource.status?.desiredNumberScheduled ?? 0);
    return desired > 0
      && Number(resource.status?.updatedNumberScheduled ?? 0) === desired
      && Number(resource.status?.numberReady ?? 0) === desired
      && Number(resource.status?.numberUnavailable ?? 0) === 0;
  }
  const replicas = Number(resource.spec?.replicas ?? 1);
  const ready = Number(resource.status?.readyReplicas ?? 0) === replicas
    && Number(resource.status?.updatedReplicas ?? 0) === replicas;
  if (!ready) return false;
  if (kind === 'statefulset') {
    return Number(resource.status?.currentReplicas ?? 0) === replicas
      && resource.status?.currentRevision === resource.status?.updateRevision;
  }
  return Number(resource.status?.availableReplicas ?? 0) === replicas
    && Number(resource.status?.unavailableReplicas ?? 0) === 0;
}

function verifyWorkloads(lock, { requireZeroRestarts, componentSelection = null }) {
  const selectedComponents = componentSelection ? new Set(componentSelection) : null;
  const expected = new Set();
  const resources = [];
  const selectedWorkloads = [];
  for (const spec of WORKLOADS) {
    if (spec.artifact && !lock.auxiliaryArtifacts?.[spec.artifact]) continue;
    if (spec.component && !lock.components?.[spec.component]) continue;
    const resource = getJson(['-n', spec.namespace, 'get', spec.kind, spec.name]);
    const podSpec = spec.kind === 'cronjob'
      ? resource.spec?.jobTemplate?.spec?.template?.spec
      : resource.spec?.template?.spec;
    const containers = spec.initContainer ? podSpec?.initContainers : podSpec?.containers;
    const container = (containers ?? []).find(({ name }) => name === spec.container);
    if (!container) throw new Error(`Workload container is missing: ${spec.namespace}/${spec.name}/${spec.container}`);
    const expectedImage = spec.artifact
      ? lock.auxiliaryArtifacts?.[spec.artifact]?.image
      : lock.components?.[spec.component]?.image;
    if (!expectedImage || container.image !== expectedImage) {
      throw new Error(`Runtime image differs from release lock: ${spec.namespace}/${spec.name} (${container.image} != ${expectedImage})`);
    }
    const pullSecrets = (podSpec?.imagePullSecrets ?? []).map(({ name }) => name);
    if (!pullSecrets.includes(REGISTRY_PULL_SECRET)) {
      throw new Error(`Workload does not reference the governed registry pull Secret: ${spec.namespace}/${spec.name}`);
    }
    expected.add(expectedImage);
    resources.push(`${spec.namespace}/${spec.kind}/${spec.name}`);
    if (!selectedComponents || selectedComponents.has(spec.component ?? spec.ownerComponent)) {
      if (spec.kind !== 'cronjob' && !workloadReady(resource)) {
        throw new Error(`Changed workload is not Ready: ${spec.namespace}/${spec.kind}/${spec.name}`);
      }
      selectedWorkloads.push({ spec, resource, expectedImage });
    }
  }
  const lockedImages = new Set([
    ...BOOTSTRAP_CORE_COMPONENTS
      .map((component) => lock.components?.[component]?.image)
      .filter(Boolean),
    ...BOOTSTRAP_AUXILIARY_ARTIFACTS
      .map((artifact) => lock.auxiliaryArtifacts?.[artifact]?.image)
      .filter(Boolean)
  ]);
  const missing = [...lockedImages].filter((image) => !expected.has(image));
  if (missing.length) throw new Error(`Release components are not represented by base workloads: ${missing.join(', ')}`);

  const allPods = getJson(['get', 'pods', '-A']).items.filter(isRuntimeServicePod);
  const pods = allPods.filter((pod) => selectedWorkloads.some(({ spec, resource, expectedImage }) => {
    if (spec.kind === 'cronjob' || pod.metadata?.namespace !== spec.namespace) return false;
    const labels = resource.spec?.selector?.matchLabels ?? {};
    return Object.entries(labels).every(([key, value]) => pod.metadata?.labels?.[key] === value)
      && (spec.initContainer ? (pod.spec?.initContainers ?? []) : (pod.spec?.containers ?? [])).some(
        ({ name, image }) => name === spec.container && image === expectedImage
      );
  }));
  for (const { spec, resource, expectedImage } of selectedWorkloads) {
    if (['cronjob', 'job'].includes(spec.kind)) continue;
    const labels = resource.spec?.selector?.matchLabels ?? {};
    const matching = pods.filter((pod) => (
      pod.metadata?.namespace === spec.namespace
      && Object.entries(labels).every(([key, value]) => pod.metadata?.labels?.[key] === value)
      && (spec.initContainer ? (pod.spec?.initContainers ?? []) : (pod.spec?.containers ?? [])).some(
        ({ name, image }) => name === spec.container && image === expectedImage
      )
    ));
    const replicas = spec.kind === 'daemonset'
      ? Number(resource.status?.desiredNumberScheduled ?? 0)
      : Number(resource.spec?.replicas ?? 1);
    if (matching.length < replicas) {
      throw new Error(`Changed workload has no complete target Pod set: ${spec.namespace}/${spec.kind}/${spec.name}`);
    }
  }
  const nonRunning = pods.filter((pod) => pod.status?.phase !== 'Running');
  if (nonRunning.length) {
    throw new Error(`OpenSphere Pods are not Running: ${nonRunning.map((pod) => `${pod.metadata.namespace}/${pod.metadata.name}:${pod.status?.phase}`).join(', ')}`);
  }
  const unready = pods.filter((pod) => !(pod.status?.conditions ?? [])
    .some((condition) => condition.type === 'Ready' && condition.status === 'True'));
  if (unready.length) {
    throw new Error(`OpenSphere Pods are not Ready: ${unready.map((pod) => `${pod.metadata.namespace}/${pod.metadata.name}`).join(', ')}`);
  }
  if (requireZeroRestarts) {
    const restarted = pods.flatMap((pod) => (pod.status?.containerStatuses ?? [])
      .filter((status) => Number(status.restartCount ?? 0) > 0)
      .map((status) => `${pod.metadata.namespace}/${pod.metadata.name}/${status.name}:${status.restartCount}`));
    if (restarted.length) throw new Error(`Fresh bootstrap has container restarts: ${restarted.join(', ')}`);
  }
  return { podCount: pods.length, resources, images: [...expected] };
}

function postgresScalar(sql) {
  return kubectl([
    '-n', 'opensphere-console-data', 'exec', 'statefulset/opensphere-supabase-postgres', '--',
    'sh', '-ec',
    `PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d postgres -At -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`
  ], { capture: true }).trim();
}

function verifySupabaseDatabase(lock) {
  const schemas = postgresScalar(
    "SELECT string_agg(schema_name, ',' ORDER BY schema_name) FROM information_schema.schemata "
    + "WHERE schema_name IN ('auth','storage','console_identity','console_operation','console_audit','console_extension','console_migration');"
  );
  for (const name of [
    'auth', 'storage', 'console_identity', 'console_operation',
    'console_audit', 'console_extension', 'console_migration'
  ]) {
    if (!schemas.split(',').includes(name)) throw new Error(`Supabase schema is missing: ${name}`);
  }

  const roles = postgresScalar(
    "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles "
    + "WHERE rolname IN ('authenticator','supabase_auth_admin','supabase_storage_admin',"
    + "'console_api','console_extension_controller','opensphere_console_api_runtime','opensphere_console_extension_runtime');"
  );
  for (const name of [
    'authenticator', 'supabase_auth_admin', 'supabase_storage_admin',
    'console_api', 'console_extension_controller',
    'opensphere_console_api_runtime', 'opensphere_console_extension_runtime'
  ]) {
    if (!roles.split(',').includes(name)) throw new Error(`Supabase runtime role is missing: ${name}`);
  }

  const ledger = postgresScalar([
    "SELECT count(*)::text || '|' ||",
    "(SELECT global_id FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1) || '|' ||",
    "(SELECT migration_set_digest FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1) || '|' ||",
    "(SELECT migration_set_size::text FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1)",
    'FROM console_migration.applied_migration;'
  ].join(' '));
  const [countText, latestGlobalId, setDigest, setSizeText] = ledger.split('|');
  const migrationCount = Number(countText);
  if (!Number.isInteger(migrationCount) || migrationCount < 1
      || migrationCount !== Number(setSizeText)
      || !/^opensphere-console\/[0-9]{8}\/[0-9]{4}$/u.test(latestGlobalId)
      || !/^sha256:[a-f0-9]{64}$/u.test(setDigest)) {
    throw new Error('Fresh Console migration ledger is incomplete or malformed');
  }
  const expected = lock.releaseBom?.migrationManifest;
  if (expected && (
    expected.latestGlobalId !== latestGlobalId
    || expected.setDigest !== setDigest
    || expected.migrationCount !== migrationCount
  )) {
    throw new Error('Fresh Console migration ledger differs from the signed Release BOM');
  }

  if (postgresScalar(
    "SELECT has_table_privilege('public','console_migration.applied_migration','UPDATE,DELETE,TRUNCATE')::text;"
  ) !== 'false') {
    throw new Error('Fresh Console migration ledger mutation privileges are not closed');
  }
  return {
    schemas: schemas.split(','),
    roles: roles.split(','),
    migrationCount,
    latestGlobalId,
    setDigest,
    appendOnly: true
  };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function waitForForward(child, timeoutMs = 30_000) {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error('Kubernetes service tunnel timed out'));
    }, timeoutMs);
    const inspect = (chunk) => {
      if (settled || !String(chunk).includes('Forwarding from 127.0.0.1:')) return;
      settled = true;
      clearTimeout(timer);
      resolveReady();
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Error(`Kubernetes service tunnel exited early (${code})`));
    });
  });
}

async function withService(namespace, service, remotePort, operation) {
  const localPort = await freePort();
  const context = process.env.OPENSPHERE_KUBE_CONTEXT;
  const args = [
    ...(context ? ['--context', context] : []),
    '-n', namespace, 'port-forward', `service/${service}`, `${localPort}:${remotePort}`, '--address', '127.0.0.1'
  ];
  const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await waitForForward(child);
    return await operation(`http://127.0.0.1:${localPort}`);
  } finally {
    child.kill();
  }
}

async function requireOk(response, label) {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${label} failed: HTTP ${response.status}${body ? ` (${body.slice(0, 240)})` : ''}`);
  }
  return response;
}

async function verifySupabaseServices() {
  await withService('opensphere-console-data', 'opensphere-supabase-auth', 9999, async (base) => {
    await requireOk(await fetch(`${base}/health`), 'Supabase Auth health');
  });
  await withService('opensphere-console-data', 'opensphere-supabase-rest', 3000, async (base) => {
    const response = await fetch(`${base}/`);
    if (![200, 401, 404].includes(response.status)) await requireOk(response, 'PostgREST health');
  });

  const secret = getJson(['-n', 'opensphere-console-data', 'get', 'secret', 'opensphere-supabase-secrets']);
  const serviceRole = decodeSecret(secret, 'service-role-key');
  // A transport/storage probe must not depend on a retired application's bucket
  // or change the owned avatar bucket. Use one private, bounded, temporary bucket.
  const bucket = `setup-conformance-${randomUUID()}`;
  const objectKey = 'roundtrip.txt';
  const body = `opensphere-supabase-storage-${randomUUID()}`;
  await withService('opensphere-console-data', 'opensphere-supabase-storage', 5000, async (base) => {
    const authorization = { apikey: serviceRole, authorization: `Bearer ${serviceRole}` };
    let created = false;
    try {
      await requireOk(await fetch(`${base}/bucket`, {
        method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 1024, allowed_mime_types: ['text/plain'] })
      }), 'Supabase Storage temporary private bucket create');
      created = true;
      await requireOk(await fetch(`${base}/object/${bucket}/${objectKey}`, {
        method: 'POST', headers: { ...authorization, 'content-type': 'text/plain' }, body
      }), 'Supabase Storage put');
      const get = await requireOk(await fetch(`${base}/object/${bucket}/${objectKey}`, {
        headers: authorization
      }), 'Supabase Storage get');
      if (await get.text() !== body) throw new Error('Supabase Storage get returned different object bytes');
      const publicRead = await fetch(`${base}/object/public/${bucket}/${objectKey}`);
      if (publicRead.ok) throw new Error('Supabase Storage probe bucket unexpectedly permits public reads');
    } finally {
      if (created) {
        const removed = await fetch(`${base}/object/${bucket}/${objectKey}`, { method: 'DELETE', headers: authorization });
        if (removed.status !== 404) await requireOk(removed, 'Supabase Storage probe object cleanup');
        await requireOk(await fetch(`${base}/bucket/${bucket}`, {
          method: 'DELETE', headers: authorization
        }), 'Supabase Storage probe bucket cleanup');
      }
    }
  });
  return { authHealth: true, restHealth: true, objectPutGetDelete: true };
}
async function giteaRequest(base, token, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      authorization: `token ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
  });
  return requireOk(response, `Gitea ${options.method ?? 'GET'} ${path}`);
}

async function verifyGitea() {
  const secret = getJson(['-n', 'opensphere-console', 'get', 'secret', 'opensphere-gitea-control-plane']);
  const token = decodeSecret(secret, 'token');
  return withService('opensphere-console-change', 'opensphere-gitea', 3000, async (base) => {
    const repository = await (await giteaRequest(base, token, '/api/v1/repos/opensphere/platform-declarations')).json();
    if (repository.private !== true || repository.default_branch !== 'main') {
      throw new Error('Gitea declaration repository is not private/main');
    }
    const protections = await (await giteaRequest(base, token, '/api/v1/repos/opensphere/platform-declarations/branch_protections')).json();
    const main = protections.find((item) => item.branch_name === 'main');
    if (!main || main.required_approvals < 1 || main.require_signed_commits !== true) {
      throw new Error('Gitea main branch protection/signature contract is incomplete');
    }

    const branch = `setup-verify-${randomUUID()}`;
    const path = `.opensphere/verification/${branch}.txt`;
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    try {
      await giteaRequest(base, token, '/api/v1/repos/opensphere/platform-declarations/branches', {
        method: 'POST',
        body: JSON.stringify({ new_branch_name: branch, old_branch_name: 'main' })
      });
      await giteaRequest(base, token, `/api/v1/repos/opensphere/platform-declarations/contents/${encodedPath}`, {
        method: 'POST',
        body: JSON.stringify({
          branch,
          message: 'OpenSphere Setup commit/read/revert conformance',
          content: Buffer.from('OpenSphere Setup Gitea conformance').toString('base64')
        })
      });
      const file = await (await giteaRequest(
        base, token,
        `/api/v1/repos/opensphere/platform-declarations/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
      )).json();
      if (Buffer.from(file.content ?? '', 'base64').toString('utf8') !== 'OpenSphere Setup Gitea conformance') {
        throw new Error('Gitea committed file differs from the written content');
      }
      await giteaRequest(base, token, `/api/v1/repos/opensphere/platform-declarations/contents/${encodedPath}`, {
        method: 'DELETE',
        body: JSON.stringify({ branch, message: 'Revert OpenSphere Setup conformance file', sha: file.sha })
      });
    } finally {
      const response = await fetch(`${base}/api/v1/repos/opensphere/platform-declarations/branches/${encodeURIComponent(branch)}`, {
        method: 'DELETE',
        headers: { authorization: `token ${token}` }
      });
      if (![204, 404].includes(response.status)) {
        throw new Error(`Gitea verification branch cleanup failed: HTTP ${response.status}`);
      }
    }
    return {
      privateRepository: true, protectedMain: true, signedCommitsRequired: true, commitReadRevert: true,
      // Bootstrap readiness does not claim the unimplemented post-merge owner.
      managementReady: false, postMergeReconciliation: 'NotImplementedInConsoleApi'
    };
  });
}

async function verifyConsoleApi() {
  return withService('opensphere-console', 'opensphere-console-api', 8080, async (base) => {
    const ready = await requireOk(await fetch(`${base}/healthz`), 'Console API readiness');
    const readiness = await ready.json();
    if (readiness.state !== 'Ready' || readiness.authority !== 'SupabasePostgreSQL') {
      throw new Error('Console API health contract differs from the Supabase authority baseline');
    }
    const bootstrap = await requireOk(
      await fetch(`${base}/api/identity/bootstrap/status`),
      'Supabase initial administrator bootstrap status'
    );
    const state = await bootstrap.json();
    if (!['required', 'complete'].includes(state.state)) {
      throw new Error(`Unsupported initial administrator state: ${state.state}`);
    }
    return { ready: true, authority: readiness.authority, initialOperatorState: state.state };
  });
}

async function verifyBeszel() {
  const service = getJson(['-n', 'opensphere-monitoring', 'get', 'service', 'beszel-hub']);
  if (service.spec?.type !== 'ClusterIP' || service.spec?.clusterIP === 'None'
      || (service.spec?.ports ?? []).some((port) => port.nodePort !== undefined)) {
    throw new Error('Beszel Hub is not a private ClusterIP-only Service');
  }
  const ingresses = getJson(['get', 'ingresses.networking.k8s.io', '-A']).items ?? [];
  const exposed = ingresses.some((ingress) => (ingress.spec?.rules ?? [])
    .flatMap((rule) => rule.http?.paths ?? [])
    .some((path) => path.backend?.service?.name === 'beszel-hub'));
  if (exposed) throw new Error('Beszel Hub must not be referenced by an Ingress');

  const bootstrap = getJson([
    '-n', 'opensphere-monitoring', 'get', 'job', 'beszel-bootstrap-v0187'
  ]);
  if (Number(bootstrap.status?.failed ?? 0) > 0
      || Number(bootstrap.status?.succeeded ?? 0) < Number(bootstrap.spec?.completions ?? 1)) {
    throw new Error('Beszel bootstrap Job has not completed successfully');
  }
  const publicKey = getJson([
    '-n', 'opensphere-monitoring', 'get', 'configmap', 'beszel-agent-public-key'
  ]).data?.key;
  if (!publicKey || publicKey === 'bootstrap-pending') {
    throw new Error('Beszel bootstrap did not publish the Hub public key');
  }
  await withService('opensphere-monitoring', 'beszel-hub', 8090, async (base) => {
    await requireOk(await fetch(`${base}/api/health`), 'Beszel Hub health');
  });
  return {
    hubPrivate: true,
    hubHealth: true,
    bootstrapJobComplete: true,
    agentPublicKeyPublished: true
  };
}

export function recordInstallationEvidence(evidence, { apply = kubectl } = {}) {
  const manifest = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'opensphere-installation-evidence',
      namespace: 'opensphere-console',
      labels: {
        'app.kubernetes.io/managed-by': 'opensphere-setup',
        'opensphere.io/evidence-kind': 'installation-verification'
      }
    },
    data: {
      'evidence.json': JSON.stringify(evidence, null, 2)
    }
  };
  apply(['apply', '-f', '-'], { capture: true, input: JSON.stringify(manifest) });
  return manifest;
}

export async function verifyInstallation(lock, {
  requireZeroRestarts = false,
  consoleUrl,
  requireRecoveryDrill = false,
  mode = 'strict',
  componentSelection = null
} = {}) {
  if (!['strict', 'rollback'].includes(mode)) throw new Error(`Unsupported installation verification mode: ${mode}`);
  const allowLegacyComponentSet = mode === 'rollback';
  validateLock(lock, { allowLegacyComponentSet });
  if (requireRecoveryDrill) {
    throw new Error('Supabase/Gitea off-backbone integrated recovery drill is not implemented; promotion verification fails closed');
  }
  const config = verifyInstallationLock(lock, { allowLegacyComponentSet });
  const secretCount = verifySecrets(lock);
  const registryPull = verifyRegistryPullPath(lock);
  const pvcCount = verifyPersistentStorage(config.storageClass);
  const serviceEndpoints = await eventuallyReady(async () => verifyServiceEndpoints(lock));
  const runtime = await eventuallyReady(async () => verifyWorkloads(lock, {
    requireZeroRestarts,
    componentSelection
  }));
  const postgresql = verifySupabaseDatabase(lock);
  const supabase = await verifySupabaseServices();
  const gitea = await verifyGitea();
  const beszel = await verifyBeszel();
  const consoleApi = await verifyConsoleApi();
  if (consoleUrl && config.consoleUrl !== consoleUrl) {
    throw new Error(`Verified Console URL differs from installation config (${consoleUrl} != ${config.consoleUrl})`);
  }
  const evidence = {
    channel: lock.channel,
    releaseDigest: lock.releaseDigest,
    verifiedAt: new Date().toISOString(),
    podCount: runtime.podCount,
    serviceCount: serviceEndpoints.length,
    pvcCount,
    secretCount,
    runtimeImagesMatchLock: true,
    requiredSecretsReady: true,
    registryPull,
    postgresql,
    supabase,
    gitea,
    beszel,
    consoleApi
  };
  recordInstallationEvidence(evidence);
  return evidence;
}
