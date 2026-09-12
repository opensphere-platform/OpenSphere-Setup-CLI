'use strict';
// CON-FR-007/018; C_API delivery and Setup observe the same bounded data volume.
// Delivered does not establish C_AI activation, embeddings or retrieval.
const NS = 'opensphere-console';
const GATEWAY = 'opensphere-console-osaa-gateway';
const VOLUME = 'platform-knowledge';
const DIRECTORY = '/var/run/opensphere-knowledge';
const canonical = value => value && typeof value === 'object'
  ? (Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])))
  : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function verifyConfigMap(actual, expected) {
  if (!actual || actual.apiVersion !== 'v1' || actual.kind !== 'ConfigMap'
    || actual.metadata?.name !== expected.metadata.name || actual.metadata?.namespace !== NS
    || actual.metadata.deletionTimestamp || actual.immutable !== true
    || !same(actual.data, expected.data) || !same(actual.binaryData, expected.binaryData)) {
    throw Error('Knowledge delivery differs from the admitted immutable package');
  }
}

function verifyGatewaySpec(spec, image, sources) {
  const containers = (spec?.containers || []).filter(c => c.name === 'gateway');
  const volumes = (spec?.volumes || []).filter(v => v.name === VOLUME);
  const container = containers[0], mounts = (container?.volumeMounts || []).filter(m => m.name === VOLUME);
  const env = (container?.env || []).filter(e => e.name === 'OSAA_KNOWLEDGE_BUNDLE_DIR');
  if (containers.length !== 1 || container.image !== image || volumes.length !== 1
    || !same(volumes[0], {name: VOLUME, projected: {defaultMode: 292, sources}})
    || mounts.length !== 1 || mounts[0].mountPath !== DIRECTORY || mounts[0].readOnly !== true
    || mounts[0].subPath || mounts[0].subPathExpr || env.length !== 1
    || env[0].value !== DIRECTORY || env[0].valueFrom) {
    throw Error('Gateway does not use the admitted read-only Knowledge volume');
  }
  return spec.volumes.indexOf(volumes[0]);
}

function verifyGatewayDeployment(deployment) {
  if (deployment?.kind !== 'Deployment' || deployment.apiVersion !== 'apps/v1'
    || deployment.metadata?.namespace !== NS || deployment.metadata?.name !== GATEWAY
    || deployment.metadata.deletionTimestamp || !deployment.metadata.uid
    || !deployment.metadata.resourceVersion || !Number.isSafeInteger(deployment.metadata.generation)
    || !Number.isSafeInteger(deployment.spec?.replicas) || deployment.spec.replicas < 1) {
    throw Error('Knowledge Gateway deployment identity or desired state is invalid');
  }
}

function deliveryObservation(deployment, podList, image, sources, replicaSets) {
  verifyGatewayDeployment(deployment);
  verifyGatewaySpec(deployment.spec.template?.spec, image, sources);
  const desired = deployment.spec.replicas;
  const observed = deployment.status || {};
  if (!Array.isArray(podList?.items) || podList.metadata?.continue) throw Error('Knowledge Gateway Pods are unavailable or incomplete');
  if (!Array.isArray(replicaSets?.items) || replicaSets.metadata?.continue) throw Error('Knowledge Gateway ReplicaSets are unavailable or incomplete');
  const owned = new Set();
  for (const rs of replicaSets.items) {
    if (rs.metadata?.namespace !== NS || !rs.metadata.uid || rs.metadata.deletionTimestamp
      || !rs.metadata.ownerReferences?.some(owner => owner.controller === true && owner.kind === 'Deployment' && owner.uid === deployment.metadata.uid)) continue;
    try { verifyGatewaySpec(rs.spec?.template?.spec, image, sources); owned.add(rs.metadata.uid); } catch { /* old revision */ }
  }
  const pods = podList.items.filter(p => !p.metadata?.deletionTimestamp && !['Succeeded', 'Failed'].includes(p.status?.phase));
  if (new Set(pods.map(p => p.metadata?.uid)).size !== pods.length) throw Error('Knowledge Gateway Pod inventory contains duplicates');
  const readyPods = pods.filter(pod => {
    if (pod.metadata?.namespace !== NS || pod.metadata?.labels?.app !== GATEWAY
      || !pod.metadata?.uid || !pod.metadata?.name || pod.status?.phase !== 'Running'
      || !pod.metadata.ownerReferences?.some(owner => owner.controller === true && owner.kind === 'ReplicaSet' && owned.has(owner.uid))
      || !pod.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')) return false;
    try { verifyGatewaySpec(pod.spec, image, sources); return true; } catch { return false; }
  }).length;
  if (deployment.spec.paused === true || observed.observedGeneration !== deployment.metadata.generation
    || observed.updatedReplicas !== desired || observed.availableReplicas !== desired || pods.length !== desired || readyPods !== desired) {
    return {state: 'Pending', reason: 'GatewayRolloutPending', readyPods, desiredPods: desired,
      activation: 'NotObserved', semanticSearch: 'NotObserved'};
  }
  return {state: 'Delivered', readyPods: pods.length, desiredPods: desired, immutable: true, readOnly: true,
    activation: 'NotObserved', semanticSearch: 'NotObserved'};
}

module.exports = {NS, GATEWAY, VOLUME, DIRECTORY, same, verifyConfigMap, verifyGatewaySpec,
  verifyGatewayDeployment, deliveryObservation};
