import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKubectl, kubectl, run } from './process.mjs';
import { validateLock } from './release.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = 'https://raw.githubusercontent.com/opensphere-platform/OpenSphere-console';

const MANIFESTS = [
  { path: 'backend/identity/kanidm-image/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-kanidm:[^\\s]+', 'kanidm']] },
  { path: 'backend/backbone/bootstrap/backbone.yaml', replacements: [
    ['opensphere-backbone-postgres@sha256:[a-f0-9]+', 'cbsPostgresql'],
    ['opensphere-backbone-rustfs@sha256:[a-f0-9]+', 'cbsRustfs'],
    ['opensphere-backbone-gitea@sha256:[a-f0-9]+', 'cbsGitea']
  ] },
  { path: 'backend/dupa-control/backboneclaim-crd.yaml' },
  { path: 'backend/dupa-control/ui-plugin-crds.yaml' },
  { path: 'backend/dupa-control/dupa-trusted-keys.yaml' },
  { path: 'backend/dupa-control/opensphere-console-dupa-controller.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-dupa-controller:[^\\s]+', 'dupaController']] },
  { path: 'backend/opensphere-console-backend/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-backend:[^\\s]+', 'backend']] },
  { path: 'backend/identity/opensphere-console-auth/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-auth:[^\\s]+', 'auth']] },
  { path: 'backend/backbone/console-services.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-oaa-gateway:[^\\s]+', 'oaaGateway']] },
  { path: 'deploy/opensphere-console.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console:[^\\s]+', 'console']] }
];

function hex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function applyYaml(yaml) {
  kubectl(['apply', '-f', '-'], { capture: true, input: yaml });
}

function ensureNamespace(name) {
  const yaml = kubectl(['create', 'namespace', name, '--dry-run=client', '-o', 'yaml'], { capture: true });
  applyYaml(yaml);
}

function ensureGenericSecret(namespace, name, literals = {}, files = {}) {
  try {
    kubectl(['-n', namespace, 'get', 'secret', name], { capture: true });
    return;
  } catch {}
  const args = ['-n', namespace, 'create', 'secret', 'generic', name];
  for (const [key, value] of Object.entries(literals)) args.push(`--from-literal=${key}=${value}`);
  for (const [key, path] of Object.entries(files)) args.push(`--from-file=${key}=${path}`);
  args.push('--dry-run=client', '-o', 'yaml');
  applyYaml(kubectl(args, { capture: true }));
}

function ensureTlsSecret(namespace, name, cert, key) {
  try {
    kubectl(['-n', namespace, 'get', 'secret', name], { capture: true });
    return;
  } catch {}
  const yaml = kubectl([
    '-n', namespace, 'create', 'secret', 'tls', name,
    `--cert=${cert}`, `--key=${key}`, '--dry-run=client', '-o', 'yaml'
  ], { capture: true });
  applyYaml(yaml);
}

async function fetchManifest(lock, spec) {
  const url = `${RAW_ROOT}/${lock.sourceRevision}/${spec.path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Manifest download failed (${spec.path}): HTTP ${response.status}`);
  let yaml = await response.text();
  for (const [pattern, component] of spec.replacements ?? []) {
    const image = lock.components[component].image;
    yaml = yaml.replace(new RegExp(pattern, 'g'), image);
  }
  for (const match of yaml.matchAll(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/gm)) {
    if (!/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(match[1])) {
      throw new Error(`Manifest ${spec.path} contains an ungoverned image reference: ${match[1]}`);
    }
  }
  return yaml;
}

function recordInstallationLock(lock) {
  const json = JSON.stringify(lock);
  const yaml = kubectl([
    '-n', 'opensphere-console', 'create', 'configmap', 'opensphere-installation-lock',
    `--from-literal=release.json=${json}`, '--dry-run=client', '-o', 'yaml'
  ], { capture: true });
  applyYaml(yaml);
}

export async function bootstrap(lock, { keepTemporaryFiles = false } = {}) {
  validateLock(lock);
  const versions = assertKubectl();
  const work = await mkdtemp(join(tmpdir(), 'opensphere-setup-'));
  try {
    console.log(`[완료] Kubernetes 연결 (${versions.cluster.serverVersion.gitVersion})`);
    for (const namespace of ['opensphere-console-auth', 'opensphere-console', 'opensphere-backbone']) ensureNamespace(namespace);

    run('pwsh', ['-NoProfile', '-File', join(HERE, 'New-Certificates.ps1'), '-OutputDirectory', work]);
    const cert = join(work, 'tls.crt');
    const key = join(work, 'tls.key');
    const sig = join(work, 'sig.key');
    ensureTlsSecret('opensphere-console-auth', 'kanidm-tls', cert, key);
    ensureTlsSecret('opensphere-console', 'kanidm-tls', cert, key);
    ensureTlsSecret('opensphere-console', 'shell-tls', cert, key);
    // nginx currently addresses tls.crt while other consumers use the conventional ca.crt.
    // Publish the same trust anchor under both stable keys during the compatibility window.
    ensureGenericSecret('opensphere-console', 'opensphere-console-auth-ca', {}, { 'ca.crt': cert, 'tls.crt': cert });
    ensureGenericSecret('opensphere-console', 'opensphere-console-auth-sig', {}, { 'sig.key': sig });
    ensureGenericSecret('opensphere-backbone', 'backbone-postgres', { password: hex(32) });
    ensureGenericSecret('opensphere-backbone', 'backbone-rustfs', {
      access_key: `os${hex(10)}`,
      secret_key: hex(32),
      endpoint: 'http://backbone-rustfs.opensphere-backbone.svc.cluster.local:9000'
    });
    ensureGenericSecret('opensphere-backbone', 'backbone-gitea', {
      db_password: hex(32),
      admin_user: 'opensphere-admin',
      admin_password: hex(24)
    });
    console.log('[완료] Namespace와 bootstrap secret 준비');

    for (const spec of MANIFESTS) {
      const yaml = await fetchManifest(lock, spec);
      const file = join(work, spec.path.replaceAll('/', '-'));
      await writeFile(file, yaml, 'utf8');
      applyYaml(yaml);
      console.log(`[완료] ${spec.path}`);
    }
    recordInstallationLock(lock);

    console.log('[대기] CBS와 Console rollout');
    for (const [namespace, resource, timeout] of [
      ['opensphere-console-auth', 'statefulset/kanidm', '360s'],
      ['opensphere-backbone', 'deployment/backbone-postgres', '600s'],
      ['opensphere-backbone', 'statefulset/backbone-rustfs', '600s'],
      ['opensphere-backbone', 'deployment/backbone-gitea', '900s'],
      ['opensphere-console', 'deployment/opensphere-console-auth', '600s'],
      ['opensphere-console', 'deployment/opensphere-console-dupa-controller', '600s'],
      ['opensphere-console', 'deployment/opensphere-console-backend', '600s'],
      ['opensphere-backbone', 'deployment/opensphere-console-oaa-gateway', '600s'],
      ['opensphere-console', 'deployment/opensphere-console', '600s']
    ]) kubectl(['-n', namespace, 'rollout', 'status', resource, `--timeout=${timeout}`]);

    console.log('[완료] OpenSphere Console edge baseline 배포');
    return { lock, temporaryDirectory: keepTemporaryFiles ? work : undefined };
  } finally {
    if (!keepTemporaryFiles) await rm(work, { recursive: true, force: true });
  }
}
