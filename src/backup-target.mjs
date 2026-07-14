const REQUIRED_KEYS = Object.freeze(['endpoint', 'bucket', 'access_key', 'secret_key', 'ca.crt']);

function decode(data, key) {
  const encoded = data?.[key];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8').trim() : '';
}

export function parseBackupTargetSecretRef(value) {
  const match = String(value ?? '').trim().match(/^([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)$/);
  if (!match) throw new Error('--backup-target-secret must be an existing namespace/name Secret reference');
  return { namespace: match[1], name: match[2] };
}

export function inspectBackupTarget(secret) {
  const missing = REQUIRED_KEYS.filter((key) => !secret?.data?.[key]);
  if (missing.length) throw new Error(`Backup target Secret is missing required keys: ${missing.join(', ')}`);

  const endpoint = decode(secret.data, 'endpoint');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Backup target endpoint must be an HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Backup target endpoint must be a plain HTTPS origin');
  }
  const bucket = decode(secret.data, 'bucket');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Backup target bucket must be a valid S3 bucket name');
  const region = decode(secret.data, 'region') || 'us-east-1';
  if (!/^[a-z0-9-]{2,32}$/.test(region)) throw new Error('Backup target region is invalid');

  const hostname = url.hostname.toLowerCase();
  const inCluster = hostname === 'localhost' || hostname.endsWith('.svc') || hostname.endsWith('.svc.cluster.local') || /^127\./.test(hostname) || hostname === '::1';
  return { endpoint: url.origin, bucket, region, inCluster };
}

export function assertReleaseBackupTarget(target, channel) {
  if (channel !== 'edge' && target.inCluster) {
    throw new Error(`${channel} requires an external S3-compatible audit backup target; in-cluster RustFS is edge-only`);
  }
  return target;
}

export function backupTargetData(source) {
  const data = {};
  for (const key of REQUIRED_KEYS) data[key] = source.data[key];
  data.region = source.data.region || Buffer.from('us-east-1').toString('base64');
  return data;
}
