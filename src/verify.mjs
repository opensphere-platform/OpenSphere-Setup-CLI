import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { kubectl } from './process.mjs';
import { validateLock } from './release.mjs';
import {
  REGISTRY_PULL_SECRET,
  releaseNeedsRegistryCredentials,
  secretHasGhcrCredential
} from './registry-pull-secret.mjs';

const NAMESPACES = Object.freeze([
  'opensphere-console-data',
  'opensphere-console-change',
  'opensphere-console-recovery',
  'opensphere-console',
  'opensphere-oaa-credentials',
  'opensphere-foundation',
  'opensphere-system'
]);

const REQUIRED_SECRETS = Object.freeze({
  'opensphere-console-data/opensphere-supabase-secrets': [
    'postgres-password', 'backend-password', 'oaa-gateway-password',
    'jwt-secret', 'anon-key', 'service-role-key'
  ],
  'opensphere-console-change/opensphere-gitea-runtime': ['postgres-password', 'db-password'],
  'opensphere-console-change/opensphere-gitea-config': ['app.ini'],
  'opensphere-console-change/opensphere-gitea-signing': ['gitea-signing-key', 'gitea-signing-key.pub'],
  'opensphere-console/shell-tls': ['tls.crt', 'tls.key'],
  'opensphere-console/opensphere-supabase-runtime': ['jwt-secret', 'service-role-key'],
  'opensphere-console/opensphere-oaa-runtime': ['pg-password'],
  'opensphere-console/opensphere-gitea-control-plane': [
    'token', 'review-token', 'webhook-secret', 'reconciler-token'
  ],
  'opensphere-console/opensphere-console-cli-runtime': ['jwt-secret'],
  'opensphere-console/opensphere-notification-runtime': [
    'encryption-key', 'internal-token', 'event-token'
  ]
});

const REQUIRED_PVCS = Object.freeze([
  ['opensphere-console-data', 'opensphere-supabase-postgres-data'],
  ['opensphere-console-data', 'opensphere-supabase-storage-data'],
  ['opensphere-console-change', 'opensphere-gitea-postgres-data'],
  ['opensphere-console-change', 'opensphere-gitea-data']
]);

const REQUIRED_SERVICES = Object.freeze([
  ['opensphere-console-data', 'opensphere-supabase-postgres'],
  ['opensphere-console-data', 'opensphere-supabase-auth'],
  ['opensphere-console-data', 'opensphere-supabase-rest'],
  ['opensphere-console-data', 'opensphere-supabase-storage'],
  ['opensphere-console-change', 'opensphere-gitea-postgres'],
  ['opensphere-console-change', 'opensphere-gitea'],
  ['opensphere-console', 'opensphere-console-backend'],
  ['opensphere-console', 'opensphere-console-dupa-controller'],
  ['opensphere-console', 'opensphere-notification-dispatcher'],
  ['opensphere-console', 'opensphere-external-channel-executor'],
  ['opensphere-console', 'opensphere-console-oaa-gateway'],
  ['opensphere-console', 'oaa-governed-adapter'],
  ['opensphere-console', 'opensphere-console-ext']
]);

const WORKLOADS = Object.freeze([
  { component: 'supabasePostgres', namespace: 'opensphere-console-data', kind: 'statefulset', name: 'opensphere-supabase-postgres', container: 'postgres' },
  { component: 'supabaseAuth', namespace: 'opensphere-console-data', kind: 'deployment', name: 'opensphere-supabase-auth', container: 'auth' },
  { component: 'supabaseRest', namespace: 'opensphere-console-data', kind: 'deployment', name: 'opensphere-supabase-rest', container: 'rest' },
  { component: 'supabaseStorage', namespace: 'opensphere-console-data', kind: 'deployment', name: 'opensphere-supabase-storage', container: 'storage' },
  { component: 'giteaPostgres', namespace: 'opensphere-console-change', kind: 'deployment', name: 'opensphere-gitea-postgres', container: 'postgres' },
  { component: 'gitea', namespace: 'opensphere-console-change', kind: 'deployment', name: 'opensphere-gitea', container: 'gitea' },
  { component: 'recovery', namespace: 'opensphere-console-data', kind: 'cronjob', name: 'opensphere-supabase-recovery-backup', container: 'recovery' },
  { component: 'recovery', namespace: 'opensphere-console-change', kind: 'cronjob', name: 'opensphere-gitea-recovery-backup', container: 'recovery' },
  { component: 'backend', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console-backend', container: 'api' },
  { component: 'dupaController', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console-dupa-controller', container: 'controller' },
  { component: 'notificationDispatcher', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-notification-dispatcher', container: 'dispatcher' },
  { component: 'notificationDispatcher', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-external-channel-executor', container: 'executor' },
  { component: 'oaaGateway', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console-oaa-gateway', container: 'gateway' },
  { component: 'oaaGovernedAdapter', namespace: 'opensphere-console', kind: 'deployment', name: 'oaa-governed-adapter', container: 'reconciler' },
  { component: 'console', namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console', container: 'shell' }
]);

function getJson(args) {
  return JSON.parse(kubectl([...args, '-o', 'json'], { capture: true }));
}

function decodeSecret(secret, key) {
  const encoded = secret.data?.[key];
  if (!encoded) throw new Error(`Secret ${secret.metadata?.namespace}/${secret.metadata?.name} lacks ${key}`);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

async function eventually(operation, timeoutMs = 120_000, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await operation();
    } catch (error) {
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
  if (config.releaseDigest !== lock.releaseDigest || config.channel !== lock.channel) {
    throw new Error('Installation config differs from the release lock');
  }
  return config;
}

function verifySecrets() {
  for (const [reference, keys] of Object.entries(REQUIRED_SECRETS)) {
    const [namespace, name] = reference.split('/');
    const secret = getJson(['-n', namespace, 'get', 'secret', name]);
    for (const key of keys) {
      if (!secret.data?.[key]) throw new Error(`Required Secret key is missing: ${reference}/${key}`);
    }
  }
  return Object.keys(REQUIRED_SECRETS).length;
}

function verifyRegistryPullPath(lock) {
  const credentialRequired = releaseNeedsRegistryCredentials(lock);
  for (const namespace of NAMESPACES) {
    const secret = getJson(['-n', namespace, 'get', 'secret', REGISTRY_PULL_SECRET]);
    if (secret.type !== 'kubernetes.io/dockerconfigjson') {
      throw new Error(`Registry pull Secret has the wrong type: ${namespace}/${REGISTRY_PULL_SECRET}`);
    }
    if (credentialRequired && !secretHasGhcrCredential(secret)) {
      throw new Error(`Private release has no GHCR credential: ${namespace}/${REGISTRY_PULL_SECRET}`);
    }
  }
  return { secret: REGISTRY_PULL_SECRET, credentialRequired, namespaces: [...NAMESPACES] };
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

export function verifyRequiredServiceEndpoints(services, endpointSlices) {
  const serviceByReference = new Map(services.map((service) => [
    `${service.metadata.namespace}/${service.metadata.name}`,
    service
  ]));
  const evidence = [];
  for (const [namespace, name] of REQUIRED_SERVICES) {
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

function verifyServiceEndpoints() {
  const services = getJson(['get', 'services', '-A']).items ?? [];
  const endpointSlices = getJson(['get', 'endpointslices.discovery.k8s.io', '-A']).items ?? [];
  return verifyRequiredServiceEndpoints(services, endpointSlices);
}

function verifyWorkloads(lock, { requireZeroRestarts }) {
  const expected = new Set();
  const resources = [];
  for (const spec of WORKLOADS) {
    const resource = getJson(['-n', spec.namespace, 'get', spec.kind, spec.name]);
    const podSpec = spec.kind === 'cronjob'
      ? resource.spec?.jobTemplate?.spec?.template?.spec
      : resource.spec?.template?.spec;
    const container = (podSpec?.containers ?? []).find(({ name }) => name === spec.container);
    if (!container) throw new Error(`Workload container is missing: ${spec.namespace}/${spec.name}/${spec.container}`);
    const expectedImage = lock.components?.[spec.component]?.image;
    if (!expectedImage || container.image !== expectedImage) {
      throw new Error(`Runtime image differs from release lock: ${spec.namespace}/${spec.name} (${container.image} != ${expectedImage})`);
    }
    const pullSecrets = (podSpec?.imagePullSecrets ?? []).map(({ name }) => name);
    if (!pullSecrets.includes(REGISTRY_PULL_SECRET)) {
      throw new Error(`Workload does not reference the governed registry pull Secret: ${spec.namespace}/${spec.name}`);
    }
    expected.add(expectedImage);
    resources.push(`${spec.namespace}/${spec.kind}/${spec.name}`);
  }
  const lockedImages = new Set(Object.values(lock.components).map(({ image }) => image));
  const missing = [...lockedImages].filter((image) => !expected.has(image));
  if (missing.length) throw new Error(`Release components are not represented by base workloads: ${missing.join(', ')}`);

  const pods = getJson(['get', 'pods', '-A']).items
    .filter((pod) => NAMESPACES.includes(pod.metadata?.namespace));
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

function verifySupabaseDatabase() {
  const schemas = postgresScalar("SELECT string_agg(schema_name, ',' ORDER BY schema_name) FROM information_schema.schemata WHERE schema_name IN ('auth','storage','console','audit','oaa');");
  for (const name of ['auth', 'storage', 'console', 'audit', 'oaa']) {
    if (!schemas.split(',').includes(name)) throw new Error(`Supabase schema is missing: ${name}`);
  }
  const roles = postgresScalar("SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('authenticator','supabase_auth_admin','supabase_storage_admin','opensphere_console_backend','opensphere_oaa_gateway');");
  for (const name of ['authenticator', 'supabase_auth_admin', 'supabase_storage_admin', 'opensphere_console_backend', 'opensphere_oaa_gateway']) {
    if (!roles.split(',').includes(name)) throw new Error(`Supabase runtime role is missing: ${name}`);
  }
  if (postgresScalar("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='audit' AND c.relname='event';") !== '1') {
    throw new Error('Supabase durable audit table is missing');
  }
  if (postgresScalar("SELECT count(*) FROM pg_policies WHERE schemaname='console';") === '0') {
    throw new Error('Supabase Console RLS policies are missing');
  }
  const requestId = randomUUID();
  const eventHash = `verify-${randomUUID()}`;
  const transaction = [
    'BEGIN;',
    `INSERT INTO audit.event(request_id,correlation_id,actor_type,action,target_type,target_id,reason,phase,result,event_hash) VALUES ('${requestId}','setup-verify','system','bootstrap.verify','installation','opensphere','Setup conformance verification','applied','ok','${eventHash}');`,
    `SELECT count(*) FROM audit.event WHERE request_id='${requestId}' AND event_hash='${eventHash}';`,
    'ROLLBACK;'
  ].join(' ');
  if (!postgresScalar(transaction).split(/\s+/).includes('1')) {
    throw new Error('Supabase append/read transaction conformance failed');
  }
  return { schemas: schemas.split(','), roles: roles.split(','), rls: true, appendRead: true };
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
  const objectKey = `setup-conformance/${randomUUID()}.txt`;
  const body = `opensphere-supabase-storage-${randomUUID()}`;
  await withService('opensphere-console-data', 'opensphere-supabase-storage', 5000, async (base) => {
    const headers = {
      apikey: serviceRole,
      authorization: `Bearer ${serviceRole}`,
      'content-type': 'text/plain',
      'x-upsert': 'true'
    };
    await requireOk(await fetch(`${base}/object/operation-artifacts/${objectKey}`, {
      method: 'POST', headers, body
    }), 'Supabase Storage put');
    const get = await requireOk(await fetch(`${base}/object/operation-artifacts/${objectKey}`, {
      headers: { apikey: serviceRole, authorization: `Bearer ${serviceRole}` }
    }), 'Supabase Storage get');
    if (await get.text() !== body) throw new Error('Supabase Storage get returned different object bytes');
    await requireOk(await fetch(`${base}/object/operation-artifacts/${objectKey}`, {
      method: 'DELETE', headers: { apikey: serviceRole, authorization: `Bearer ${serviceRole}` }
    }), 'Supabase Storage delete');
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
    return { privateRepository: true, protectedMain: true, signedCommitsRequired: true, commitReadRevert: true };
  });
}

async function verifyConsoleBackend() {
  return withService('opensphere-console', 'opensphere-console-backend', 8080, async (base) => {
    const ready = await requireOk(await fetch(`${base}/readyz`), 'Console Backend readiness');
    const readiness = await ready.json();
    if (readiness.ready === false) throw new Error('Console Backend reports Supabase unavailable');
    const bootstrap = await requireOk(
      await fetch(`${base}/api/identity/bootstrap/status`),
      'Supabase initial operator bootstrap status'
    );
    const state = await bootstrap.json();
    if (!['required', 'complete'].includes(state.state)) throw new Error(`Unsupported initial operator state: ${state.state}`);
    return { ready: true, initialOperatorState: state.state };
  });
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
  mode = 'strict'
} = {}) {
  if (!['strict', 'rollback'].includes(mode)) throw new Error(`Unsupported installation verification mode: ${mode}`);
  const allowLegacyComponentSet = mode === 'rollback';
  validateLock(lock, { allowLegacyComponentSet });
  if (requireRecoveryDrill) {
    throw new Error('Supabase/Gitea off-backbone integrated recovery drill is not implemented; promotion verification fails closed');
  }
  const config = verifyInstallationLock(lock, { allowLegacyComponentSet });
  const secretCount = verifySecrets();
  const registryPull = verifyRegistryPullPath(lock);
  const pvcCount = verifyPersistentStorage(config.storageClass);
  const serviceEndpoints = await eventually(async () => verifyServiceEndpoints());
  const runtime = await eventually(async () => verifyWorkloads(lock, { requireZeroRestarts }));
  const postgresql = verifySupabaseDatabase();
  const supabase = await verifySupabaseServices();
  const gitea = await verifyGitea();
  const backend = await verifyConsoleBackend();
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
    backend
  };
  recordInstallationEvidence(evidence);
  return evidence;
}
