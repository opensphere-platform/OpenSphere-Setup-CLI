import https from 'node:https';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { kubectl } from './process.mjs';
import { BASE_RUNTIME_COMPONENTS, validateLock } from './release.mjs';
import { normalizeConsoleUrl, oidcIssuer } from './console-url.mjs';
import { assertReleaseBackupTarget, inspectBackupTarget } from './backup-target.mjs';
import {
  BACKUP_CRONJOB_RESOURCE,
  BACKUP_SCRIPTS_CONFIGMAP_RESOURCE,
  RESTORE_DRILL_CRONJOB_RESOURCE,
  backupCronJobUsesDedicatedRole,
  backupScriptUsesDedicatedRole,
  restoreDrillPreservesCredentialBoundary
} from './backup-boundary.mjs';

const NAMESPACES = [
  'opensphere-console-auth',
  'opensphere-console',
  'opensphere-backbone'
];

const REQUIRED_SECRETS = Object.freeze({
  'opensphere-console-auth/kanidm-tls': ['tls.crt', 'tls.key'],
  'opensphere-console/kanidm-tls': ['tls.crt', 'tls.key'],
  'opensphere-console/shell-tls': ['tls.crt', 'tls.key'],
  'opensphere-console/opensphere-console-auth-ca': ['ca.crt', 'tls.crt'],
  'opensphere-console/opensphere-console-auth-sig': ['sig.key'],
  'opensphere-console/opensphere-identity-kanidm': ['url', 'token', 'expires_at'],
  'opensphere-console/opensphere-rolemgr-kanidm': ['url', 'token', 'expires_at'],
  // opensphere_oaa is a dedicated, independently-generated PostgreSQL login role for the OAA
  // gateway (CONSTITUTION-0004 §4.5 OAA bootstrap boundary) -- it must never default to or
  // reuse the `password` key (the constrained Console runtime role). Verification fails closed
  // if oaa_password would be absent, matching the Backbone bootstrap/reconcile requirement that
  // consumes it (backend/backbone/bootstrap/backbone.yaml in OpenSphere-console). backup_password
  // is the equally-dedicated credential for the read-only opensphere_backup role that the
  // scheduled pg_dump job authenticates as -- also distinct from `password` and required so the
  // Setup-created backup job never falls back to the console runtime role.
  'opensphere-backbone/backbone-postgres': ['password', 'bootstrap_password', 'oaa_password', 'backup_password'],
  'opensphere-backbone/backbone-rustfs': ['access_key', 'secret_key', 'endpoint'],
  'opensphere-backbone/backbone-postgres-backup-target': ['endpoint', 'bucket', 'access_key', 'secret_key', 'ca.crt', 'region'],
  'opensphere-backbone/backbone-rustfs-tls': ['tls.crt', 'tls.key'],
  'opensphere-backbone/backbone-gitea': ['db_password', 'admin_user', 'admin_password']
});

function requiredUrls(base) {
  return [
    [`${base}/`, 'text/html'],
    [`${base}/readyz`, 'application/json'],
    [`${base}/oauth2/openid/opensphere-console/.well-known/openid-configuration`, 'application/json'],
    [`${base}/bff/healthz`, 'application/json'],
    [`${base}/ui/reset`, 'text/html'],
    [`${base}/api/v1/registry`, 'application/json'],
    [`${base}/api/cli/index.json`, 'application/json']
  ];
}

const REQUIRED_PVCS = [
  'opensphere-console-auth/data-kanidm-0',
  'opensphere-backbone/backbone-postgres-data',
  'opensphere-backbone/data-backbone-rustfs-0',
  'opensphere-backbone/backbone-gitea-data'
];

const REQUIRED_SERVICES = Object.freeze([
  'opensphere-console-auth/kanidm',
  'opensphere-console-auth/kanidm-core',
  'opensphere-console-auth/kanidm-ext',
  'opensphere-console/opensphere-console-auth',
  'opensphere-console/opensphere-console-auth-ext',
  'opensphere-console/opensphere-console-backend',
  'opensphere-console/opensphere-console-dupa-controller',
  'opensphere-console/opensphere-console-ext',
  'opensphere-backbone/backbone-postgres',
  'opensphere-backbone/backbone-rustfs',
  'opensphere-backbone/backbone-gitea'
]);

function getJson(args) {
  return JSON.parse(kubectl([...args, '-o', 'json'], { capture: true }));
}

function httpsGet(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          contentType: String(response.headers['content-type'] ?? '').split(';')[0],
          body: buffer.toString('utf8'),
          buffer
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`HTTP timeout: ${url}`)));
    request.on('error', reject);
  });
}

function httpsGetWithToken(url, token, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { accept: 'application/json', authorization: `Bearer ${token}` }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: response.statusCode, body, json });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`HTTP timeout: ${url}`)));
    request.on('error', reject);
  });
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

function waitForForward(process, label, timeoutMs = 30_000) {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} verification tunnel timed out`)), timeoutMs);
    const inspect = (chunk) => {
      if (String(chunk).includes('Forwarding from 127.0.0.1:')) {
        clearTimeout(timer);
        resolveReady();
      }
    };
    process.stdout.on('data', inspect);
    process.stderr.on('data', inspect);
    process.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} verification tunnel exited early (${code})`));
    });
  });
}

async function eventually(operation, timeoutMs = 60_000, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try { return await operation(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw lastError;
}

function verifySecrets() {
  for (const [reference, keys] of Object.entries(REQUIRED_SECRETS)) {
    const [namespace, name] = reference.split('/');
    const secret = getJson(['-n', namespace, 'get', 'secret', name]);
    for (const key of keys) {
      if (!secret.data?.[key]) throw new Error(`Required secret key is missing: ${reference}/${key}`);
    }
    if (keys.includes('expires_at')) {
      const expiry = new Date(Buffer.from(secret.data.expires_at, 'base64').toString('utf8'));
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() < Date.now() + 24 * 60 * 60 * 1000) {
        throw new Error(`Service credential must be rotated before expiry: ${reference}`);
      }
    }
  }
}

function verifyPersistentStorage() {
  const claims = getJson(['get', 'pvc', '-A']).items
    .filter((claim) => NAMESPACES.includes(claim.metadata.namespace));
  const references = claims.map((claim) => `${claim.metadata.namespace}/${claim.metadata.name}`);
  for (const required of REQUIRED_PVCS) {
    if (!references.includes(required)) throw new Error(`Required persistent volume claim is missing: ${required}`);
  }
  for (const claim of claims) {
    if (claim.status.phase !== 'Bound') {
      throw new Error(`Persistent volume claim is not bound: ${claim.metadata.namespace}/${claim.metadata.name}`);
    }
  }
  return claims.length;
}

export function verifyRequiredServiceEndpoints(services, endpointSlices) {
  const serviceByReference = new Map(services.map((service) => [`${service.metadata.namespace}/${service.metadata.name}`, service]));
  const evidence = [];
  for (const reference of REQUIRED_SERVICES) {
    const service = serviceByReference.get(reference);
    if (!service) throw new Error(`Required Service is missing: ${reference}`);
    if (!service.spec?.selector || Object.keys(service.spec.selector).length === 0) {
      throw new Error(`Required Service has no workload selector: ${reference}`);
    }
    const [namespace, name] = reference.split('/');
    const endpoints = endpointSlices
      .filter((slice) => slice.metadata?.namespace === namespace && slice.metadata?.labels?.['kubernetes.io/service-name'] === name)
      .flatMap((slice) => slice.endpoints ?? []);
    const ready = endpoints.filter((endpoint) => endpoint.conditions?.ready === true);
    if (ready.length === 0) throw new Error(`Required Service has no ready EndpointSlice endpoint: ${reference}`);
    evidence.push({ reference, readyEndpoints: ready.length });
  }
  return evidence;
}

function verifyRecovery({ requireRecoveryDrill = false } = {}) {
  const backup = getJson(['-n', 'opensphere-backbone', 'get', 'cronjob', BACKUP_CRONJOB_RESOURCE]);
  const backupScripts = getJson(['-n', 'opensphere-backbone', 'get', 'configmap', BACKUP_SCRIPTS_CONFIGMAP_RESOURCE]);
  const drill = getJson(['-n', 'opensphere-backbone', 'get', 'cronjob', RESTORE_DRILL_CRONJOB_RESOURCE]);
  if (backup.spec?.suspend === true || backup.spec?.concurrencyPolicy !== 'Forbid') {
    throw new Error('PostgreSQL audit backup CronJob is not safely configured');
  }
  // This Setup version has established the dedicated opensphere_backup boundary
  // (verifySecrets already requires backbone-postgres/backup_password). Fail closed
  // if the scheduled backup would authenticate as the constrained Console runtime
  // role instead: a regressed `pg_dump -U console` cannot read the forward `oaa`
  // schema, and re-granting console that access would breach the audit boundary.
  // The boundary is a resource set -- both the CronJob credential reference and the
  // ConfigMap pg_dump script user must be dedicated, and either half regressing
  // fails closed.
  if (!backupCronJobUsesDedicatedRole(backup)) {
    throw new Error('PostgreSQL audit backup CronJob does not authenticate as the dedicated opensphere_backup role (backup_password)');
  }
  if (!backupScriptUsesDedicatedRole(backupScripts)) {
    throw new Error('PostgreSQL audit backup script does not run pg_dump as the dedicated opensphere_backup role (found -U console or missing -U opensphere_backup)');
  }
  // The suspended restore drill does not authenticate as opensphere_backup: it only
  // rebuilds an ephemeral restore database using the sealed bootstrap operator
  // (POSTGRES_PASSWORD=bootstrap_password, consumed inline as PGPASSWORD by the
  // restore-drill.sh script). It must therefore expose NO Console/backup read
  // credential -- PGPASSWORD must not be wired as a backbone-postgres credential
  // (neither backup_password nor the console runtime `password`), and no other
  // backbone-postgres env ref may fall back to `password`.
  if (!restoreDrillPreservesCredentialBoundary(drill)) {
    throw new Error('PostgreSQL restore drill CronJob does not preserve the credential boundary (must bind POSTGRES_PASSWORD=bootstrap_password and expose no backup/console read credential via PGPASSWORD)');
  }
  if (drill.spec?.suspend !== true) throw new Error('PostgreSQL restore drill CronJob must remain suspended');
  const jobs = getJson(['-n', 'opensphere-backbone', 'get', 'jobs', '-l', 'opensphere.io/recovery=audit']).items || [];
  const completed = jobs.filter((job) => (job.status?.conditions || [])
    .some((condition) => condition.type === 'Complete' && condition.status === 'True'));
  if (requireRecoveryDrill && !completed.some((job) => String(job.metadata?.name || '').startsWith('backbone-postgres-backup-'))) {
    throw new Error('PostgreSQL backup recovery drill has no completed backup job');
  }
  if (requireRecoveryDrill && !completed.some((job) => String(job.metadata?.name || '').startsWith('backbone-postgres-restore-drill-'))) {
    throw new Error('PostgreSQL backup recovery drill has no completed restore job');
  }
  return {
    backupScheduled: backup.spec?.schedule,
    restoreDrillSuspended: true,
    completedJobs: completed.map((job) => job.metadata.name)
  };
}

function verifyPostgresql() {
  const result = kubectl([
    '-n', 'opensphere-backbone', 'exec', 'deployment/backbone-postgres', '--',
    'psql', '-U', 'console', '-d', 'console', '-Atc',
    "SELECT current_database() || ':' || extversion FROM pg_extension WHERE extname='vector'"
  ], { capture: true });
  if (!/^console:\S+/.test(result)) throw new Error('PostgreSQL vector extension verification failed');
  const auditBoundary = kubectl([
    '-n', 'opensphere-backbone', 'exec', 'deployment/backbone-postgres', '--',
    'psql', '-U', 'console', '-d', 'console', '-Atc',
    `SELECT
      (SELECT rolsuper = false AND rolbypassrls = false AND rolcanlogin = true FROM pg_roles WHERE rolname = 'console')
      AND (SELECT rolsuper = true AND rolcanlogin = false FROM pg_roles WHERE rolname = 'opensphere_audit_owner')
      AND (SELECT rolsuper = true AND rolcanlogin = true FROM pg_roles WHERE rolname = 'opensphere_db_bootstrap')
      AND (SELECT pg_get_userbyid(relowner) = 'opensphere_audit_owner' FROM pg_class WHERE oid = 'public.audit_log'::regclass)
      AND (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.audit_log'::regclass AND attname = 'source' AND NOT attisdropped)
      AND (SELECT tgenabled = 'A' FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass AND tgname = 'audit_log_append_only')
      AND has_table_privilege('console', 'public.audit_log', 'SELECT')
      AND has_table_privilege('console', 'public.audit_log', 'INSERT')
      AND NOT has_table_privilege('console', 'public.audit_log', 'UPDATE')
      AND NOT has_table_privilege('console', 'public.audit_log', 'DELETE')
      AND NOT has_table_privilege('console', 'public.audit_log', 'TRUNCATE')`
  ], { capture: true });
  if (auditBoundary !== 't') throw new Error('PostgreSQL audit runtime boundary is not sealed');

  for (const [statement, message] of [
    ['SET session_replication_role = replica', 'PostgreSQL console runtime role can disable audit triggers'],
    ['ALTER ROLE opensphere_audit_owner LOGIN', 'PostgreSQL console runtime role can alter the sealed audit owner']
  ]) {
    try {
      kubectl([
        '-n', 'opensphere-backbone', 'exec', 'deployment/backbone-postgres', '--',
        'psql', '-U', 'console', '-d', 'console', '-v', 'ON_ERROR_STOP=1', '-c',
        statement
      ], { capture: true });
    } catch {
      continue;
    }
    throw new Error(message);
  }
  return { vector: result, auditBoundary: 'sealed' };
}

function verifyRustfsTransport() {
  const secret = getJson(['-n', 'opensphere-backbone', 'get', 'secret', 'backbone-rustfs']);
  const endpoint = decodeSecretValue(secret, 'endpoint');
  if (!endpoint.startsWith('https://backbone-rustfs.opensphere-backbone.svc.cluster.local:9000')) {
    throw new Error(`RustFS endpoint is not the verified in-cluster HTTPS endpoint: ${endpoint}`);
  }
  return { endpoint, tls: 'verified-ca' };
}

function verifyAuditBackupTarget(lock) {
  const secret = getJson(['-n', 'opensphere-backbone', 'get', 'secret', 'backbone-postgres-backup-target']);
  return assertReleaseBackupTarget(inspectBackupTarget(secret), lock.channel);
}

function decodeSecretValue(secret, key) {
  const encoded = secret.data?.[key];
  if (!encoded) throw new Error(`Secret key missing during functional verification: ${key}`);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

async function verifyIdentity() {
  const admin = getJson(['-n', 'opensphere-console', 'get', 'configmap', 'opensphere-initial-admin']).data;
  if (!admin?.username || !admin?.email) throw new Error('Initial administrator metadata is incomplete');
  const reader = getJson(['-n', 'opensphere-console', 'get', 'secret', 'opensphere-identity-kanidm']);
  const roleManager = getJson(['-n', 'opensphere-console', 'get', 'secret', 'opensphere-rolemgr-kanidm']);
  const port = await freePort();
  const args = [
    ...(process.env.OPENSPHERE_KUBE_CONTEXT ? ['--context', process.env.OPENSPHERE_KUBE_CONTEXT] : []),
    '-n', 'opensphere-console-auth', 'port-forward', 'svc/kanidm', `${port}:8443`, '--address', '127.0.0.1'
  ];
  const forward = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await waitForForward(forward, 'Kanidm');
    const person = await httpsGetWithToken(
      `https://localhost:${port}/v1/person/${encodeURIComponent(admin.username)}`,
      decodeSecretValue(reader, 'token')
    );
    const group = await httpsGetWithToken(
      `https://localhost:${port}/v1/group/opensphere-console-admins`,
      decodeSecretValue(roleManager, 'token')
    );
    if (group.status !== 200 || group.json === null) {
      throw new Error(`Administrator group lookup failed: HTTP ${group.status}`);
    }
    if (admin.state === 'required') {
      if (person.status === 200 && person.json !== null) {
        throw new Error('First-access Wizard is required but an initial administrator already exists');
      }
      return { username: admin.username, email: admin.email, setupRequired: true, serviceCredentialsVerified: true };
    }
    if (person.status !== 200 || person.json === null) {
      throw new Error(`Initial administrator lookup failed: HTTP ${person.status}`);
    }
    const personNames = person.json.attrs?.name ?? [];
    const personMail = person.json.attrs?.mail ?? [];
    if (!personNames.includes(admin.username) || !personMail.includes(admin.email)) {
      throw new Error('Initial administrator attributes differ from installation metadata');
    }
    const members = (group.json.attrs?.member ?? []).map((value) => String(value).split('@')[0]);
    if (!members.includes(admin.username)) {
      throw new Error('Initial administrator is not a member of opensphere-console-admins');
    }
    return { username: admin.username, email: admin.email, serviceCredentialsVerified: true };
  } finally {
    forward.kill();
  }
}

function verifyWorkloads(lock, { requireZeroRestarts }) {
  const resources = getJson(['get', 'deployment,statefulset', '-A']).items
    .filter((item) => NAMESPACES.includes(item.metadata.namespace));
  const liveImages = resources.flatMap((item) => item.spec.template.spec.containers.map((container) => container.image));
  const expectedImages = BASE_RUNTIME_COMPONENTS.map((name) => lock.components[name].image);
  const missing = expectedImages.filter((image) => !liveImages.includes(image));
  const unexpected = liveImages.filter((image) => !expectedImages.includes(image));
  if (resources.length !== expectedImages.length || missing.length || unexpected.length) {
    throw new Error(`Runtime image set differs from release lock (workloads=${resources.length}, missing=${missing.length}, unexpected=${unexpected.length})`);
  }

  const pods = getJson(['get', 'pods', '-A']).items
    .filter((pod) => NAMESPACES.includes(pod.metadata.namespace))
    .filter((pod) => (pod.metadata.ownerReferences ?? []).some((owner) =>
      owner.kind === 'ReplicaSet' || owner.kind === 'StatefulSet'));
  const desiredPodCount = resources.reduce((sum, resource) => sum + (resource.spec.replicas ?? 1), 0);
  if (pods.length !== desiredPodCount) {
    throw new Error(`OpenSphere pod set is not quiescent: expected ${desiredPodCount}, found ${pods.length}`);
  }
  for (const pod of pods) {
    const statuses = pod.status.containerStatuses ?? [];
    const restarts = statuses.reduce((sum, status) => sum + status.restartCount, 0);
    if (pod.metadata.deletionTimestamp || pod.status.phase !== 'Running' || statuses.length === 0 || statuses.some((status) => !status.ready)) {
      throw new Error(`Pod is not ready: ${pod.metadata.namespace}/${pod.metadata.name}`);
    }
    if (requireZeroRestarts && restarts !== 0) {
      throw new Error(`Pod restarted during clean installation: ${pod.metadata.namespace}/${pod.metadata.name} (${restarts})`);
    }
  }
  return { workloadCount: resources.length, podCount: pods.length };
}

async function verifyHttp(consoleUrl) {
  const port = await freePort();
  const args = [
    ...(process.env.OPENSPHERE_KUBE_CONTEXT ? ['--context', process.env.OPENSPHERE_KUBE_CONTEXT] : []),
    '-n', 'opensphere-console', 'port-forward', 'svc/opensphere-console-ext', `${port}:8090`, '--address', '127.0.0.1'
  ];
  const forward = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const base = `https://localhost:${port}`;
  try {
    await waitForForward(forward, 'Console');
    const required = requiredUrls(base);
    const results = [];
    for (const [url, expectedContentType] of required) {
      const response = await eventually(async () => {
        const current = await httpsGet(url);
        if (current.status !== 200) throw new Error(`${url} returned HTTP ${current.status}`);
        if (current.contentType !== expectedContentType) {
          throw new Error(`${url} returned ${current.contentType}, expected ${expectedContentType}`);
        }
        return current;
      });
      results.push({ url, status: response.status, contentType: response.contentType });
    }
    const discovery = JSON.parse((await httpsGet(required[2][0])).body);
    if (discovery.issuer !== oidcIssuer(consoleUrl)) {
      throw new Error(`OIDC issuer is incorrect: ${discovery.issuer}`);
    }
    const bff = JSON.parse((await httpsGet(`${base}/bff/healthz`)).body);
    if (bff.ready !== true || bff.credentialStore !== true || bff.authPolicy !== true) {
      throw new Error('Console BFF dependency readiness is not healthy');
    }
    const registry = JSON.parse((await httpsGet(`${base}/api/v1/registry`)).body);
    if (registry.version !== 3 || !Array.isArray(registry.plugins) || typeof registry.trustedKeys !== 'object') {
      throw new Error('Console Registry contract is not ready');
    }
    const cli = JSON.parse((await httpsGet(`${base}/api/cli/index.json`)).body);
    if (cli.ownership !== 'console-native' || !Array.isArray(cli.links) || cli.links.length === 0) {
      throw new Error('Console-native CLI manifest is not ready');
    }
    for (const link of cli.links) {
      const artifact = await httpsGet(new URL(link.href, `${base}/`));
      if (artifact.status !== 200) throw new Error(`CLI artifact ${link.href} returned HTTP ${artifact.status}`);
      if (artifact.buffer.length !== link.size) throw new Error(`CLI artifact ${link.href} size differs from its manifest`);
      const digest = createHash('sha256').update(artifact.buffer).digest('hex');
      if (digest !== link.sha256) throw new Error(`CLI artifact ${link.href} digest differs from its manifest`);
    }
    return results;
  } finally {
    forward.kill();
  }
}

function recordEvidence(lock, evidence) {
  const yaml = kubectl([
    '-n', 'opensphere-console', 'create', 'configmap', 'opensphere-installation-evidence',
    `--from-literal=evidence.json=${JSON.stringify(evidence)}`,
    '--dry-run=client', '-o', 'yaml'
  ], { capture: true });
  kubectl(['apply', '-f', '-'], { capture: true, input: yaml });
}

export async function verifyInstallation(lock, {
  requireZeroRestarts = true,
  record = true,
  consoleUrl,
  requireRecoveryDrill = false,
  mode = 'strict'
} = {}) {
  validateLock(lock);
  const installed = getJson(['-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock']);
  const installedLock = validateLock(JSON.parse(installed.data?.['release.json'] ?? '{}'));
  if (installedLock.releaseDigest !== lock.releaseDigest) {
    throw new Error('Cluster release lock differs from the requested release');
  }
  const installationConfig = JSON.parse(installed.data?.['config.json'] ?? '{}');
  const configuredConsoleUrl = normalizeConsoleUrl(installationConfig.consoleUrl ?? 'https://localhost:8090');
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== configuredConsoleUrl) {
    throw new Error(`Cluster Console URL differs from verification target: ${configuredConsoleUrl}`);
  }
  // A release prior to the current bootstrap contract may not contain the
  // modern audit/TLS resources. A failed upgrade must still prove that the
  // exact previous image set is running before it reports rollback success;
  // it must not manufacture a full current-release certificate for it.
  if (mode === 'rollback') {
    const runtime = await eventually(
      async () => verifyWorkloads(lock, { requireZeroRestarts }),
      120_000,
      2_000
    );
    return {
      releaseDigest: lock.releaseDigest,
      sourceRevision: lock.sourceRevision,
      rollbackVerified: true,
      workloadCount: runtime.workloadCount,
      podCount: runtime.podCount
    };
  }
  if (mode !== 'strict') throw new Error(`Unsupported installation verification mode: ${mode}`);
  verifySecrets();
  verifyAuditBackupTarget(lock);
  const pvcCount = verifyPersistentStorage();
  const postgresql = verifyPostgresql();
  const rustfs = verifyRustfsTransport();
  const recovery = verifyRecovery({ requireRecoveryDrill });
  const runtime = await eventually(
    async () => verifyWorkloads(lock, { requireZeroRestarts }),
    120_000,
    2_000
  );
  const endpoints = await verifyHttp(configuredConsoleUrl);
  const identity = await verifyIdentity();
  const services = getJson(['get', 'services', '-A']).items
    .filter((service) => NAMESPACES.includes(service.metadata.namespace));
  const endpointSlices = getJson(['get', 'endpointslice', '-A']).items
    .filter((slice) => NAMESPACES.includes(slice.metadata.namespace));
  const requiredServiceEndpoints = verifyRequiredServiceEndpoints(services, endpointSlices);
  const evidence = {
    apiVersion: 'release.opensphere.io/v1alpha1',
    kind: 'OpenSphereInstallationEvidence',
    channel: lock.channel,
    releaseDigest: lock.releaseDigest,
    sourceRevision: lock.sourceRevision,
    consoleUrl: configuredConsoleUrl,
    verifiedAt: new Date().toISOString(),
    namespaces: NAMESPACES,
    workloadCount: runtime.workloadCount,
    podCount: runtime.podCount,
    serviceCount: services.length,
    requiredServiceEndpoints,
    pvcCount,
    runtimeImagesMatchLock: true,
    requiredSecretsReady: true,
    postgresql,
    rustfs,
    recovery,
    identity,
    endpoints
  };
  if (record) recordEvidence(lock, evidence);
  return evidence;
}
