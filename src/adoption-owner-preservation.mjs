// Setup consumes the versioned signed readiness predicate. It never maps its
// source minimum to a runtime deactivation list. Existing Owner lifecycle stays
// with Setup/owner paths. This comparison grants no execution authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { kubectl } from './process.mjs';
import { calculateReleaseBomDigest } from './release.mjs';
import { verifyOwnerPreservation, validateReadinessProfile } from './release-readiness-profile.mjs';
import artifactVersions from './artifact-version.cjs';

export function requiresOwnerPreservation(targetLock, previousLock) {
  const profile = targetLock.releaseBom?.readinessProfile;
  if (targetLock.releaseBom && artifactVersions.parseArtifactVersion(targetLock.releaseBom.releaseTag)?.format === 'build'
    && targetLock.releaseDigest !== previousLock.releaseDigest) {
    assert.ok(profile, 'New formal adoption requires a signed readiness predicate');
  }
  return profile !== undefined;
}

const key = w => `${w.kind}/${w.metadata.namespace}/${w.metadata.name}`;
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
function project(workload, repositories, fallback) {
  const spec = structuredClone(workload.spec);
  delete spec.replicas;
  // Init-container configuration and images remain unchanged in this minimal
  // adoption. They cannot silently substitute an unverified executable.
  for (const c of spec.template?.spec?.containers ?? []) delete c.image;
  const hash = 'sha256:' + createHash('sha256').update(JSON.stringify(stable(spec))).digest('hex');
  const containers = workload.spec.template.spec.containers.map(c => ({
    name: c.name, image: c.image,
    features: Object.fromEntries((c.env ?? []).filter(e => e.name === 'R2D2_HERMES_ENABLED')
      .map(e => [e.name, e.value])),
  }));
  const owner = [...new Set(containers.map(c => repositories[c.image?.split('@')[0]]).filter(Boolean))].sort().join('+');
  return { kind: workload.kind, namespace: workload.metadata.namespace, name: workload.metadata.name,
    owner, uid: workload.metadata.uid, resourceVersion: workload.metadata.resourceVersion,
    replicas: workload.kind === 'DaemonSet' ? workload.status?.desiredNumberScheduled ?? fallback?.replicas : workload.spec.replicas ?? 1,
    configurationDigest: hash, containers };
}

export function readOwnerObservation(previousLock, { client = kubectl, now = Date.now() } = {}) {
  const record = JSON.parse(client(['get', 'configmap', 'opensphere-installation-lock', '-n', 'opensphere-console', '-o', 'json'], { capture: true }));
  const current = JSON.parse(record.data?.['release.json'] ?? 'null');
  assert.equal(current?.releaseDigest, previousLock.releaseDigest, 'Installation changed before Owner comparison');
  const repositories = Object.fromEntries(Object.entries({ ...previousLock.components, ...previousLock.auxiliaryArtifacts })
    .map(([name, component]) => [`ghcr.io/opensphere-platform/${component.repository}`, name]));
  const raw = JSON.parse(client(['get', 'deployment,statefulset,daemonset', '-A', '-o', 'json'], { capture: true }));
  assert.ok(Array.isArray(raw.items), 'Owner discovery returned no Kubernetes list');
  const active = raw.items.filter(w => (w.spec?.template?.spec?.containers ?? []).some(c => repositories[c.image?.split('@')[0]])
    && (w.kind === 'DaemonSet' ? w.status?.desiredNumberScheduled > 0 : (w.spec?.replicas ?? 1) > 0));
  return { repositories, installed: { observedUtc: new Date(now).toISOString(),
    releaseDigest: previousLock.releaseDigest, resourceVersion: record.metadata.resourceVersion,
    workloads: active.map(w => project(w, repositories)) } };
}

export function comparePreparedOwners(previousLock, targetLock, prepared, {
  verifiedBom, client = kubectl, now = Date.now()
} = {}) {
  const pointer = targetLock.releaseBom;
  assert.ok(pointer?.readinessProfile, 'Signed readiness predicate is missing from installation lock');
  validateReadinessProfile(pointer.readinessProfile, targetLock.sourceRevision);
  assert.ok(verifiedBom?.bom, 'Verified signed BOM is required before Owner comparison');
  assert.equal(verifiedBom.digest, pointer.digest, 'Verified BOM and installation lock differ');
  assert.equal(calculateReleaseBomDigest(verifiedBom.bom), pointer.digest, 'Verified BOM bytes changed');
  assert.deepEqual(verifiedBom.bom.readinessProfile, pointer.readinessProfile, 'Signed readiness predicate changed');
  const observed = readOwnerObservation(previousLock, { client, now });
  const documents = prepared.all.flatMap(item => {
    assert.equal(typeof item.yaml, 'string', 'Rendered artifact bytes are missing');
    return parseAllDocuments(item.yaml).map(doc => {
      if (doc.errors.length) throw new Error('Rendered Owner manifest is invalid YAML');
      return doc.toJS();
    }).filter(Boolean);
  });
  const rendered = new Map();
  for (const document of documents.filter(d => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(d.kind))) {
    assert.ok(!rendered.has(key(document)), 'Rendered plan declares a workload twice');
    rendered.set(key(document), document);
  }
  const inputs = observed.installed.workloads.map(before => {
    const identity = `${before.kind}/${before.namespace}/${before.name}`;
    assert.ok(rendered.has(identity), `Active Owner omitted from rendered artifacts: ${identity}`);
    return rendered.get(identity);
  });
  // Server dry-run performs admission/defaulting/merge without persisting any
  // resource. Never emit the private manifest or API response to logs.
  let dryRun;
  try {
    dryRun = JSON.parse(client(['apply', '--dry-run=server', '--validate=true', '-f', '-', '-o', 'json'], {
      capture: true, input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: inputs })
    }));
  } catch {
    // Admission errors can echo private manifest fields. Keep their payload
    // out of Setup logs and operation results.
    throw new Error('Owner server dry-run failed; no adoption writes performed');
  }
  const plannedRaw = dryRun.kind === 'List' ? dryRun.items : [dryRun];
  assert.ok(Array.isArray(plannedRaw) && plannedRaw.length === inputs.length, 'Server dry-run Owner set is incomplete');
  const beforeByKey = new Map(observed.installed.workloads.map(w => [`${w.kind}/${w.namespace}/${w.name}`, w]));
  const planned = plannedRaw.map(w => {
    const before = beforeByKey.get(key(w));
    assert.ok(before, 'Server dry-run returned an unrequested Owner');
    const after = project(w, observed.repositories, before);
    // Image digests must belong to the already verified target lock. Matching
    // package names alone is not enough to substitute an unverified image.
    for (const c of after.containers) assert.ok(Object.values({ ...targetLock.components, ...targetLock.auxiliaryArtifacts })
      .some(a => a.image === c.image), 'Rendered Owner contains an image outside the verified target lock');
    return { ...after, baseUid: after.uid, baseResourceVersion: after.resourceVersion };
  });
  const fresh = readOwnerObservation(previousLock, { client, now });
  assert.deepEqual(fresh.installed, observed.installed, 'Installed Owner or lock changed during render comparison');
  return verifyOwnerPreservation({ profile: pointer.readinessProfile, sourceRevision: targetLock.sourceRevision,
    installed: observed.installed, rendered: { sourceRevision: targetLock.sourceRevision,
      baseReleaseDigest: observed.installed.releaseDigest, baseResourceVersion: observed.installed.resourceVersion,
      deactivations: [], workloads: planned }, now });
}
