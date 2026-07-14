const PRODUCTION_PROFILE = 'durable-v1';
const REDUNDANT_FAILURE_DOMAINS = new Set(['multi-node', 'zone-redundant', 'region-redundant']);

export function assertStorageProfile(storageClass, channel) {
  if (!storageClass?.metadata?.name || !storageClass?.provisioner) throw new Error('StorageClass metadata is incomplete');
  if (channel === 'edge') return { name: storageClass.metadata.name, profile: 'edge' };

  const annotations = storageClass.metadata.annotations ?? {};
  const problems = [];
  if (/local-path|hostpath|docker-desktop|kind/i.test(storageClass.provisioner)) problems.push('provisioner is node-local');
  if (annotations['opensphere.io/backbone-storage-profile'] !== PRODUCTION_PROFILE) problems.push(`opensphere.io/backbone-storage-profile=${PRODUCTION_PROFILE} is required`);
  if (annotations['opensphere.io/encryption-at-rest'] !== 'true') problems.push('opensphere.io/encryption-at-rest=true is required');
  if (!REDUNDANT_FAILURE_DOMAINS.has(annotations['opensphere.io/failure-domain'])) problems.push('opensphere.io/failure-domain must declare multi-node, zone-redundant, or region-redundant');
  if (storageClass.reclaimPolicy !== 'Retain') problems.push('reclaimPolicy Retain is required');
  if (storageClass.allowVolumeExpansion !== true) problems.push('allowVolumeExpansion=true is required');
  if (problems.length) throw new Error(`${channel} requires a certified durable StorageClass (${problems.join('; ')})`);
  return { name: storageClass.metadata.name, profile: PRODUCTION_PROFILE };
}
