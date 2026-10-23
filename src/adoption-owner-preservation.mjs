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
import {captureNativeCutover,buildNativeRecoveryProof} from './native-r2d2-owner-cutover.mjs';
const RAW_OWNERS=Symbol('private Owner bodies');
const RAW_RECORD=Symbol('private installation record');

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
export function projectOwnerObservation(workload, repositories, fallback, nativeReferenceLock) {
  const spec = structuredClone(workload.spec);
  delete spec.replicas;
  // Init-container configuration and images remain unchanged in this minimal
  // adoption. They cannot silently substitute an unverified executable.
  for (const c of spec.template?.spec?.containers ?? []) delete c.image;
  if(nativeReferenceLock?.components?.r2d2OpenClawGateway&&key(workload)==='Deployment/opensphere-console/opensphere-console-osaa-gateway'){
    const gateways=(spec.template?.spec?.containers??[]).filter(c=>c.name==='gateway');
    assert.equal(gateways.length,1,'Native image reference requires its exact control-plane container');
    for(const[name,component]of[['R2D2_NATIVE_GATEWAY_IMAGE','r2d2OpenClawGateway'],['R2D2_NATIVE_BRIDGE_IMAGE','osaaGateway']]){
      const entries=(gateways[0].env??[]).filter(e=>e.name===name);
      assert.equal(entries.length,1,'Native release image reference is missing or duplicated');
      assert.equal(entries[0].value,nativeReferenceLock.components[component].image,'Native image environment differs from the verified release');
      assert.deepEqual(Object.keys(entries[0]).sort(),['name','value'],'Native image reference is not a public literal');
      // These are release image references, like container.image above. No
      // other environment, policy or configuration field is normalized.
      entries[0].value='release-component://'+component;
    }
  }
  const hash = 'sha256:' + createHash('sha256').update(JSON.stringify(stable(spec))).digest('hex');
  const containers = workload.spec.template.spec.containers.map(c => ({
    name: c.name, image: c.image,
    features: Object.fromEntries((c.env ?? []).filter(e => ['R2D2_HERMES_ENABLED','R2D2_BACKEND'].includes(e.name))
      .map(e => [e.name, e.value])),
  }));
  const owner = [...new Set(containers.map(c => repositories[c.image?.split('@')[0]]).filter(Boolean))].sort().join('+');
  return { kind: workload.kind, namespace: workload.metadata.namespace, name: workload.metadata.name,
    owner, uid: workload.metadata.uid, resourceVersion: workload.metadata.resourceVersion,
    replicas: workload.kind === 'DaemonSet' ? workload.status?.desiredNumberScheduled ?? fallback?.replicas : workload.spec.replicas ?? 1,
    configurationDigest: hash, containers };
}

// The dedicated per-user runtimes are dynamically owned by C_AI, not part of
// the static Console release inventory. Exclude only the exact owned shape;
// an unexpected workload remains in the comparison and fails closed.
export function isPersonalNativeOwnerWorkload(workload,installationId){
 const m=workload.metadata??{},labels=m.labels??{},annotations=m.annotations??{},p=workload.spec?.template?.spec??{};
 const id=labels['opensphere.io/r2d2-runtime'],owner=annotations['opensphere.io/r2d2-owner-digest'];
 const installation=typeof installationId==='string'?createHash('sha256').update(installationId).digest('hex'):null;
 return workload.kind==='Deployment'&&m.namespace==='opensphere-r2d2'&&/^[a-f0-9]{40}$/.test(id??'')&&m.name==='r2d2-'+id
  &&labels['app.kubernetes.io/name']==='r2d2-openclaw-runtime'&&labels['app.kubernetes.io/managed-by']==='opensphere-r2d2'
  &&/^[a-f0-9]{64}$/.test(owner??'')&&owner.startsWith(id)&&installation!==null&&annotations['opensphere.io/r2d2-installation-digest']===installation
  &&workload.spec?.template?.metadata?.annotations?.['opensphere.io/r2d2-owner-digest']===owner
  &&workload.spec?.template?.metadata?.annotations?.['opensphere.io/r2d2-installation-digest']===installation
  &&p.serviceAccountName==='r2d2-personal-runtime'&&p.automountServiceAccountToken===false
  &&JSON.stringify((p.containers??[]).map(c=>c.name))===JSON.stringify(['gateway','bridge'])
  &&/^ghcr\.io\/opensphere-platform\/opensphere-console-r2d2-openclaw@sha256:[a-f0-9]{64}$/.test(p.containers[0].image??'')
  &&/^ghcr\.io\/opensphere-platform\/opensphere-console-osaa-gateway@sha256:[a-f0-9]{64}$/.test(p.containers[1].image??'');
}

export function readOwnerObservation(previousLock, { client = kubectl, now = Date.now(),normalizeNativeImages=false,recoveryCheckpoint } = {}) {
  const record = JSON.parse(client(['get', 'configmap', 'opensphere-installation-lock', '-n', 'opensphere-console', '-o', 'json'], { capture: true }));
  const current = JSON.parse(record.data?.['release.json'] ?? 'null');
  const config=JSON.parse(record.data?.['config.json']??'null');
  assert.equal(current?.releaseDigest, previousLock.releaseDigest, 'Installation changed before Owner comparison');
  const repositories = Object.fromEntries(Object.entries({ ...previousLock.components, ...previousLock.auxiliaryArtifacts })
    .map(([name, component]) => [`ghcr.io/opensphere-platform/${component.repository}`, name]));
  if(recoveryCheckpoint) repositories['ghcr.io/opensphere-platform/opensphere-console-r2d2-hermes-worker']='r2d2HermesWorker';
  const raw = JSON.parse(client(['get', 'deployment,statefulset,daemonset', '-A', '-o', 'json'], { capture: true }));
  assert.ok(Array.isArray(raw.items), 'Owner discovery returned no Kubernetes list');
  const active = raw.items.filter(w => !isPersonalNativeOwnerWorkload(w,config?.installationId)
    && (w.spec?.template?.spec?.containers ?? []).some(c => repositories[c.image?.split('@')[0]])
    && (w.kind === 'DaemonSet' ? w.status?.desiredNumberScheduled > 0 : (w.spec?.replicas ?? 1) > 0));
  const result={ repositories, installed: { observedUtc: new Date(now).toISOString(),
    releaseDigest: previousLock.releaseDigest, recordUid: record.metadata.uid, resourceVersion: record.metadata.resourceVersion,
    workloads: active.map(w => projectOwnerObservation(w, repositories,undefined,normalizeNativeImages?previousLock:undefined)) } };
  Object.defineProperty(result,RAW_OWNERS,{value:new Map(active.map(w=>[key(w),w]))});
  Object.defineProperty(result,RAW_RECORD,{value:record});
  return result;
}

export function comparePreparedOwners(previousLock, targetLock, prepared, {
  verifiedBom, client = kubectl, now = Date.now(), nativeRecovery = false
} = {}) {
  const pointer = targetLock.releaseBom;
  assert.ok(pointer?.readinessProfile, 'Signed readiness predicate is missing from installation lock');
  validateReadinessProfile(pointer.readinessProfile, targetLock.sourceRevision);
  assert.ok(verifiedBom?.bom, 'Verified signed BOM is required before Owner comparison');
  assert.equal(verifiedBom.digest, pointer.digest, 'Verified BOM and installation lock differ');
  assert.equal(calculateReleaseBomDigest(verifiedBom.bom), pointer.digest, 'Verified BOM bytes changed');
  assert.deepEqual(verifiedBom.bom.readinessProfile, pointer.readinessProfile, 'Signed readiness predicate changed');
  const normalizeNativeImages=pointer.readinessProfile.name!=='native-r2d2-cutover';
  const recoveryRequested=nativeRecovery&&pointer.readinessProfile.name==='native-r2d2-cutover';
  const observed = readOwnerObservation(previousLock, { client, now,normalizeNativeImages,recoveryCheckpoint:recoveryRequested });
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
  const nativeInput={previousLock,targetLock,plan:prepared.foundation?.nativeRuntime,record:observed[RAW_RECORD],
    before:observed[RAW_OWNERS].get('Deployment/opensphere-console/opensphere-console-osaa-gateway'),
    after:plannedRaw.find(w=>key(w)==='Deployment/opensphere-console/opensphere-console-osaa-gateway')};
  const checkpoint=pointer.readinessProfile.name==='native-r2d2-cutover'&&!recoveryRequested?captureNativeCutover(nativeInput):undefined;
  const recoveryProof=recoveryRequested?buildNativeRecoveryProof({...nativeInput,
    installationIdentity:JSON.parse(client(['get','configmap','opensphere-installation-identity','-n','opensphere-console','-o','json'],{capture:true}))}):undefined;
  const nativeCutover=checkpoint?.proof;
  const planned = plannedRaw.map(w => {
    const before = beforeByKey.get(key(w));
    assert.ok(before, 'Server dry-run returned an unrequested Owner');
    const after = projectOwnerObservation(w, observed.repositories, before,normalizeNativeImages?targetLock:undefined);
    // Image digests must belong to the already verified target lock. Matching
    // package names alone is not enough to substitute an unverified image.
    for (const c of after.containers) assert.ok(Object.values({ ...targetLock.components, ...targetLock.auxiliaryArtifacts })
      .some(a => a.image === c.image), 'Rendered Owner contains an image outside the verified target lock');
    return { ...after, baseUid: after.uid, baseResourceVersion: after.resourceVersion };
  });
  const fresh = readOwnerObservation(previousLock, { client, now,normalizeNativeImages,recoveryCheckpoint:recoveryRequested });
  assert.deepEqual(fresh.installed, observed.installed, 'Installed Owner or lock changed during render comparison');
  const result=verifyOwnerPreservation({ profile: pointer.readinessProfile, sourceRevision: targetLock.sourceRevision,
    installed: observed.installed, rendered: { sourceRevision: targetLock.sourceRevision,
      baseReleaseDigest: observed.installed.releaseDigest, baseResourceVersion: observed.installed.resourceVersion,
      deactivations: [], workloads: planned }, now,nativeCutover,nativeRecovery:recoveryProof });
  return {...result,...(checkpoint?{nativeCutoverCheckpoint:checkpoint}:{}),...(recoveryProof?{nativeCutoverCheckpoint:JSON.parse(observed[RAW_RECORD].data['state.json']).transition.nativeCutoverCheckpoint,nativeRecoveryState:recoveryProof.state}:{})};
}
