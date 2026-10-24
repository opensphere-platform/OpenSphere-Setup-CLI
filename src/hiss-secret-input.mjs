import { run } from './process.mjs';
import { installTarget } from './install-target.mjs';

// Protected input for the HISS credentials of RKE2 readiness stage R1 (plan 2026-10-24 §4.2: "R1: Setup 보안 입력 →
// Secret"). The administrator pipes one JSON object to `opensphere-setup prepare-hiss-secret <kind>`; values never
// appear as arguments, in output, logs or errors, and the agent that runs the command never sees them. Setup writes
// one fixed-name Secret per kind with server-side apply; Cluster Manager and RKE2 read it by name.
//
// - alert-emergency: monitoring/opensphere-alert-emergency, the temporary emergency receiver (A-D1). Slack or SMTP,
//   plus an optional dead-man URL. Expires at the Console alert path (R2-C1) or 2026-11-30, whichever is earlier.
//   Setup also records the non-secret receiver values (kind; SMTP smarthost, sender, recipients) in the ConfigMap
//   monitoring/opensphere-alert-emergency-allowed, the parameter of the admission policy that lets Cluster Manager's
//   AlertmanagerConfig use exactly those values. --clear keeps the ConfigMap with receiver-kind none, so the route can
//   still be removed.
// - backup-store: longhorn-system/opensphere-backup-<name>, the S3 key Longhorn uses for its backup target (B1).
// - etcd-s3: kube-system/opensphere-etcd-s3, RKE2's etcd snapshot S3 settings (etcd-s3-config-secret, B1).
const fail = (code, message) => Object.assign(new Error(message), { code });
export const EMERGENCY_DEADLINE = '2026-11-30T00:00:00+09:00';
export const MAX_INPUT_BYTES = 16 * 1024;
const SLACK_HOSTS = new Set(['hooks.slack.com', 'hooks.slack-gov.com']);
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const DNS = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IPV4 = /^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/;
export const EMERGENCY_ALLOWED = 'opensphere-alert-emergency-allowed';

function closed(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_INPUT', 'The input must be one JSON object');
  const extra = Object.keys(input).filter(k => ![...required, ...optional].includes(k));
  if (extra.length) throw fail('INVALID_INPUT', `Unknown input field: ${extra[0]}`);
  const absent = required.filter(k => input[k] === undefined || input[k] === '');
  if (absent.length) throw fail('INVALID_INPUT', `Missing input field: ${absent[0]}`);
  for (const [k, v] of Object.entries(input)) if (!['string', 'boolean', 'number'].includes(typeof v) && !Array.isArray(v)) throw fail('INVALID_INPUT', `Input field ${k} has the wrong type`);
}
const str = (v, field, max = 2048) => { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\r\n\0]/.test(v)) throw fail('INVALID_INPUT', `${field} must be a single-line string`); return v.trim(); };
function httpsUrl(v, field, { hosts, allowIp = false } = {}) {
  let url; try { url = new URL(str(v, field)); } catch { throw fail('INVALID_INPUT', `${field} must be a URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw fail('INVALID_INPUT', `${field} must be an https URL without credentials in it`);
  if (hosts && !hosts.has(url.hostname)) throw fail('INVALID_INPUT', `${field} must point at ${[...hosts].join(' or ')}`);
  if (!hosts && !(allowIp && IPV4.test(url.hostname)) && (!DNS.test(url.hostname) || /^localhost$/i.test(url.hostname))) throw fail('INVALID_INPUT', `${field} must name a DNS host${allowIp ? ' or an IPv4 address' : ''}`);
  return url.href;
}
const pem = (v, field) => { if (typeof v !== 'string' || v.length > 12000 || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(v.trim())) throw fail('INVALID_INPUT', `${field} must be PEM certificates`); return v.trim() + '\n'; };
const bool = (v, field) => { if (v === undefined) return undefined; if (typeof v !== 'boolean') throw fail('INVALID_INPUT', `${field} must be true or false`); return String(v); };

function emergencyData(input) {
  if (input?.receiverKind === 'slack') {
    closed(input, ['receiverKind', 'slackApiUrl'], ['slackChannel', 'deadmanUrl']);
    const data = { 'receiver-kind': 'slack', 'slack-api-url': httpsUrl(input.slackApiUrl, 'slackApiUrl', { hosts: SLACK_HOSTS }) };
    if (input.slackChannel !== undefined) { const c = str(input.slackChannel, 'slackChannel', 80); if (!/^#?[a-z0-9][a-z0-9._-]{0,79}$/.test(c)) throw fail('INVALID_INPUT', 'slackChannel is not a channel name'); data['slack-channel'] = c; }
    if (input.deadmanUrl !== undefined) data['deadman-url'] = httpsUrl(input.deadmanUrl, 'deadmanUrl');
    return data;
  }
  if (input?.receiverKind === 'smtp') {
    closed(input, ['receiverKind', 'smtpHost', 'smtpPort', 'from', 'to'], ['username', 'password', 'requireTls', 'deadmanUrl']);
    const host = str(input.smtpHost, 'smtpHost', 253);
    if (!DNS.test(host) || /^localhost$/i.test(host)) throw fail('INVALID_INPUT', 'smtpHost must be a DNS name (not an address or localhost)');
    if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65535) throw fail('INVALID_INPUT', 'smtpPort must be a port number');
    const to = (Array.isArray(input.to) ? input.to : String(input.to).split(',')).map(v => String(v).trim()).filter(Boolean);
    if (!EMAIL.test(str(input.from, 'from', 320)) || !to.length || to.length > 30 || to.some(v => !EMAIL.test(v))) throw fail('INVALID_INPUT', 'from and to must be e-mail addresses (1-30 recipients)');
    if ((input.username === undefined) !== (input.password === undefined)) throw fail('INVALID_INPUT', 'username and password go together');
    const data = { 'receiver-kind': 'smtp', 'smtp-smarthost': `${host}:${input.smtpPort}`, 'smtp-from': input.from.trim(), 'smtp-to': to.join(','),
      'smtp-require-tls': bool(input.requireTls, 'requireTls') ?? 'true' };
    if (input.username !== undefined) { data['smtp-auth-username'] = str(input.username, 'username', 256); data['smtp-auth-password'] = str(input.password, 'password', 1024); }
    if (input.deadmanUrl !== undefined) data['deadman-url'] = httpsUrl(input.deadmanUrl, 'deadmanUrl');
    return data;
  }
  throw fail('INVALID_INPUT', 'receiverKind must be slack or smtp');
}

// Longhorn's S3 credential Secret keys.
function backupStoreData(input) {
  closed(input, ['accessKeyId', 'secretAccessKey', 'endpoint'], ['caCertificates', 'virtualHostedStyle']);
  const data = { AWS_ACCESS_KEY_ID: str(input.accessKeyId, 'accessKeyId', 256), AWS_SECRET_ACCESS_KEY: str(input.secretAccessKey, 'secretAccessKey', 1024),
    AWS_ENDPOINTS: httpsUrl(input.endpoint, 'endpoint', { allowIp: true }).replace(/\/$/, '') };
  // Longhorn 1.12 rejects an AWS_CERT that ends with a newline (B0 lab 2026-10-24).
  if (input.caCertificates !== undefined) data.AWS_CERT = pem(input.caCertificates, 'caCertificates').trimEnd();
  if (input.virtualHostedStyle !== undefined) data.VIRTUAL_HOSTED_STYLE = bool(input.virtualHostedStyle, 'virtualHostedStyle');
  return data;
}

// RKE2's etcd-s3-config-secret keys (one per etcd-s3-* server option; k3s pkg/etcd/s3/config_secret.go, read in the B0 lab).
function etcdS3Data(input) {
  closed(input, ['endpoint', 'accessKey', 'secretKey', 'bucket'], ['region', 'folder', 'endpointCa', 'skipSslVerify', 'timeout', 'retention', 'bucketLookupType']);
  const endpoint = str(input.endpoint, 'endpoint', 253);
  if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(endpoint) || endpoint.includes('://')) throw fail('INVALID_INPUT', 'endpoint is host[:port] without a scheme, as RKE2 expects');
  const bucket = str(input.bucket, 'bucket', 63);
  if (!S3_BUCKET.test(bucket)) throw fail('INVALID_INPUT', 'bucket is not an S3 bucket name');
  // Path-style lookup by default: an in-house S3 (address or plain host) rarely serves bucket subdomains (B0 lab 2026-10-24).
  const lookup = input.bucketLookupType === undefined ? 'path' : str(input.bucketLookupType, 'bucketLookupType', 8);
  if (!['auto', 'dns', 'path'].includes(lookup)) throw fail('INVALID_INPUT', 'bucketLookupType is auto, dns or path');
  const data = { 'etcd-s3-endpoint': endpoint, 'etcd-s3-access-key': str(input.accessKey, 'accessKey', 256), 'etcd-s3-secret-key': str(input.secretKey, 'secretKey', 1024), 'etcd-s3-bucket': bucket,
    'etcd-s3-bucket-lookup-type': lookup };
  if (input.region !== undefined) { const r = str(input.region, 'region', 32); if (!REGION.test(r)) throw fail('INVALID_INPUT', 'region is not a region name'); data['etcd-s3-region'] = r; }
  if (input.folder !== undefined) { const f = str(input.folder, 'folder', 200); if (!/^[A-Za-z0-9._\/-]+$/.test(f)) throw fail('INVALID_INPUT', 'folder is not an object prefix'); data['etcd-s3-folder'] = f; }
  if (input.endpointCa !== undefined) data['etcd-s3-endpoint-ca'] = pem(input.endpointCa, 'endpointCa');
  if (input.skipSslVerify !== undefined) data['etcd-s3-skip-ssl-verify'] = bool(input.skipSslVerify, 'skipSslVerify');
  if (input.retention !== undefined) { if (!Number.isInteger(input.retention) || input.retention < 1 || input.retention > 100) throw fail('INVALID_INPUT', 'retention is the number of snapshots to keep (1-100)'); data['etcd-s3-retention'] = String(input.retention); }
  if (input.timeout !== undefined) { const t = str(input.timeout, 'timeout', 8); if (!/^[1-9][0-9]{0,2}[sm]$/.test(t)) throw fail('INVALID_INPUT', 'timeout is a duration such as 5m'); data['etcd-s3-timeout'] = t; }
  return data;
}

export function hissSecretTarget(kind, name) {
  if (kind === 'alert-emergency') return { namespace: 'monitoring', name: 'opensphere-alert-emergency' };
  if (kind === 'etcd-s3') return { namespace: 'kube-system', name: 'opensphere-etcd-s3' };
  if (kind === 'backup-store') {
    if (typeof name !== 'string' || !NAME.test(name)) throw fail('INVALID_INPUT', '--name must be 1-40 lower-case letters, digits or hyphens');
    return { namespace: 'longhorn-system', name: `opensphere-backup-${name}` };
  }
  throw fail('INVALID_INPUT', 'kind must be alert-emergency, backup-store or etcd-s3');
}

export function buildHissSecret(kind, input, { name, expiresAt, now = Date.now() } = {}) {
  const target = hissSecretTarget(kind, name);
  const data = kind === 'alert-emergency' ? emergencyData(input) : kind === 'backup-store' ? backupStoreData(input) : etcdS3Data(input);
  const annotations = { 'opensphere.io/written-by': 'opensphere-setup prepare-hiss-secret', 'opensphere.io/written-at': new Date(now).toISOString() };
  if (kind === 'alert-emergency') {
    const deadline = Date.parse(EMERGENCY_DEADLINE), requested = expiresAt === undefined ? deadline : Date.parse(expiresAt);
    if (!Number.isFinite(requested) || requested <= now) throw fail('INVALID_INPUT', '--expires-at must be a future ISO time');
    if (requested > deadline) throw fail('INVALID_INPUT', `The emergency route expires at ${EMERGENCY_DEADLINE} at the latest`);
    annotations['opensphere.io/expires-at'] = new Date(requested).toISOString();
  }
  return { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { ...target,
    labels: { 'app.kubernetes.io/part-of': 'opensphere-console', 'app.kubernetes.io/managed-by': 'OpenSphere-Setup', 'opensphere.io/hiss-secret': kind },
    annotations }, data: Object.fromEntries(Object.entries(data).sort().map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')])) };
}

// The admission-policy parameter for the emergency route: only non-secret values, exactly as Cluster Manager renders them.
export function emergencyAllowedConfigMap(secret) {
  const data = secret ? Object.fromEntries(Object.entries(secret.data).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')])) : {};
  const allowed = { 'receiver-kind': data['receiver-kind'] || 'none' };
  if (allowed['receiver-kind'] === 'smtp') for (const key of ['smtp-smarthost', 'smtp-from', 'smtp-to']) allowed[key] = data[key];
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: 'monitoring', name: EMERGENCY_ALLOWED,
    labels: { 'app.kubernetes.io/part-of': 'opensphere-console', 'app.kubernetes.io/managed-by': 'OpenSphere-Setup', 'opensphere.io/hiss-secret': 'alert-emergency' } }, data: allowed };
}

// Reads the protected input: a pipe only, bounded, one JSON object.
export async function readHissSecretInput(stream = process.stdin) {
  if (stream.isTTY) throw fail('INVALID_INPUT', 'Pipe the JSON input (for example from a file only you can read); values are never accepted as arguments or typed visibly');
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += Buffer.byteLength(chunk); if (size > MAX_INPUT_BYTES) throw fail('INVALID_INPUT', 'The input is too large'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('INVALID_INPUT', 'The input is not JSON'); }
}

// Writes (or with clear, removes) the Secret. The result names the Secret and its keys, never a value; a kubectl
// failure is reported without its diagnostics, which could quote the object.
export function writeHissSecret(kind, input, scope, { runner = run, name, expiresAt, clear = false, confirm, now } = {}) {
  const target = installTarget(scope);
  const secretTarget = hissSecretTarget(kind, name);
  const kubectl = (args, stdin) => {
    try { return String(runner('kubectl', ['--context', target.context, ...args], { capture: true, ...(stdin !== undefined ? { input: stdin } : {}) }) || ''); }
    catch (error) { throw fail('KUBECTL_FAILED', `kubectl ${args[0]} for ${secretTarget.namespace}/${secretTarget.name} failed (exit ${error.exitStatus ?? 'unknown'}); diagnostics withheld because they may quote credential values`); }
  };
  if (!kubectl(['get', 'namespace', secretTarget.namespace, '--ignore-not-found', '-o', 'name', '--request-timeout=10s']).trim()) {
    throw fail('PREPARATION_BLOCKED', `Namespace ${secretTarget.namespace} does not exist`);
  }
  const apply = object => kubectl(['apply', '--server-side', '--field-manager=opensphere-setup-hiss', '-f', '-', '--request-timeout=20s'], JSON.stringify(object));
  if (clear) {
    if (confirm !== secretTarget.name) throw fail('INVALID_INPUT', `--clear needs --confirm ${secretTarget.name}`);
    kubectl(['-n', secretTarget.namespace, 'delete', 'secret', secretTarget.name, '--ignore-not-found', '--request-timeout=20s']);
    if (kind === 'alert-emergency') apply(emergencyAllowedConfigMap(null));
    return { state: 'Removed', secret: `${secretTarget.namespace}/${secretTarget.name}` };
  }
  const secret = buildHissSecret(kind, input, { name, expiresAt, now });
  // A Secret once written with client-side `kubectl apply` keeps its old values in this annotation (the 10-23 pull Secret
  // finding); it goes before the new values are written. Removing an absent annotation is a no-op.
  if (kubectl(['-n', secretTarget.namespace, 'get', 'secret', secretTarget.name, '--ignore-not-found', '-o', 'name', '--request-timeout=10s']).trim()) {
    kubectl(['-n', secretTarget.namespace, 'annotate', 'secret', secretTarget.name, 'kubectl.kubernetes.io/last-applied-configuration-', '--request-timeout=20s']);
  }
  apply(secret);
  if (kind === 'alert-emergency') apply(emergencyAllowedConfigMap(secret));
  return { state: 'Applied', secret: `${secretTarget.namespace}/${secretTarget.name}`, keys: Object.keys(secret.data),
    ...(secret.metadata.annotations['opensphere.io/expires-at'] ? { expiresAt: secret.metadata.annotations['opensphere.io/expires-at'] } : {}),
    next: kind === 'alert-emergency' ? 'cluster-manager.hiss.alerts.apply part=emergency'
      : kind === 'backup-store' ? `cluster-manager.hiss.backup.target.set credentialSecret=${secretTarget.name}`
        : 'master config.yaml etcd-s3: true, etcd-s3-config-secret: opensphere-etcd-s3 (host step)' };
}
