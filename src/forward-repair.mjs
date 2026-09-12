import { createHash } from 'node:crypto';
import { isLocalEdgeLock } from './release.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export function installationRecordDigest(record) {
  if (record?.kind !== 'ConfigMap' || record.metadata?.name !== 'opensphere-installation-lock'
    || record.metadata.namespace !== 'opensphere-console' || record.metadata.deletionTimestamp
    || !record.metadata.uid || !record.metadata.resourceVersion || !record.data) throw Error('Invalid installation record');
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical({
    uid: record.metadata.uid, resourceVersion: record.metadata.resourceVersion, data: record.data,
  }))).digest('hex');
}

// Explicit repair of an incomplete local installation. This is not a provenance
// exception: every target artifact must still pass normal strict verification.
// The previous record is incident evidence, never a claimed rollback release.
export function assertForwardRepair({ previous, target, record, expectedRecordDigest, context }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedRecordDigest ?? '')
    || installationRecordDigest(record) !== expectedRecordDigest) throw Error('Installation record changed; review a fresh repair plan');
  if (context !== 'docker-desktop' || !isLocalEdgeLock(target) || target.channel !== 'edge'
    || target.digestFormat !== 'canonical-json-v1' || target.releaseScope !== 'component') {
    throw Error('Forward repair is restricted to a verified localhost edge component target');
  }
  const stored = JSON.parse(record.data['release.json']);
  const config = JSON.parse(record.data['config.json']);
  const state = JSON.parse(record.data['state.json'] ?? '{}');
  if (stored.releaseDigest !== previous.releaseDigest
    || JSON.stringify(canonical(stored)) !== JSON.stringify(canonical(previous))
    || config.architecture !== 'supabase-data-identity+gitea-change-authority'
    || config.consoleUrl !== 'https://localhost:1114' || config.channel !== 'edge') {
    throw Error('Forward repair does not match the current localhost installation');
  }
  if (config.releaseDigest === stored.releaseDigest && state.phase === 'Ready') {
    throw Error('A consistent Ready installation must use the ordinary upgrade transaction');
  }
  if (Object.keys(previous.components).sort().join(',') !== Object.keys(target.components).sort().join(',')) {
    throw Error('Forward repair cannot add, remove or rename release components');
  }
  return { uid: record.metadata.uid, resourceVersion: record.metadata.resourceVersion,
    expectedRecordDigest, previousReleaseDigest: previous.releaseDigest,
    targetReleaseDigest: target.releaseDigest, rollbackAvailable: false };
}
