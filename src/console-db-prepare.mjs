// `opensphere-setup prepare-console-db`: plan or apply the CloudNativePG operator for the Console DB (R2-C2 scope 1).
//
// Order (the fence-first rule of the HISS artifacts, review M5 of 2026-10-22): the operator namespace and the admission
// fence are applied and type-checked first, then the CRDs, then the NetworkPolicies, and only then the operator's RBAC,
// webhooks and Deployment. A failure before the last phase leaves no operator permission behind. Server-side apply
// under one field manager; never --force-conflicts, so an object another manager owns stops the apply.
// After the apply, three proofs on the live API servers:
//   - the fence refuses, as the operator, a Secret outside its Cluster (dry-run create) and deleting the retired
//     StatefulSet's PVC (dry-run delete): RBAC allows both, so only the fence can refuse them;
//   - the webhook answers through the M1 NetworkPolicy: a server-side dry-run of the Console DB Cluster passes the
//     operator's mutating and validating webhooks.
import { observeInstalledHissTarget } from './prepare-installed-hiss.mjs';
import { run } from './process.mjs';
import {
  CLUSTER_NAME, DATA_NAMESPACE, FENCE_NAME, FIELD_MANAGER, LEGACY_PVC, OPERATOR_NAMESPACE, OPERATOR_SERVICE_ACCOUNT, OPERATOR_USER,
  kubernetesApiPeers, renderConsoleDbCluster, renderOperatorObjects,
} from './console-db-cnpg.mjs';

const fail = (code, message, evidence) => Object.assign(new Error(message), { code, ...(evidence ? { evidence } : {}) });
const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const canonical = (v) => JSON.stringify(sorted(v));
const identity = (o) => `${o.kind}/${o.metadata?.namespace || ''}/${o.metadata?.name}`;

// Every field we set is present with the same value; server defaults and other managers' fields are ignored. RBAC
// rules, subjects and policy expressions must match exactly.
function holds(live, wanted) {
  if (Array.isArray(wanted)) return Array.isArray(live) && live.length === wanted.length && wanted.every((v, i) => holds(live[i], v));
  if (wanted && typeof wanted === 'object') return !!live && typeof live === 'object' && Object.keys(wanted).every((k) => holds(live[k], wanted[k]));
  return live === wanted;
}
export function objectMatches(document, live) {
  if (!live?.metadata?.uid || live.metadata.deletionTimestamp) return false;
  if (!holds(live.metadata.labels || {}, document.metadata.labels || {})) return false;
  if (document.rules) return canonical(live.rules || []) === canonical(document.rules);
  if (document.roleRef) return canonical(live.roleRef) === canonical(document.roleRef) && canonical(live.subjects || []) === canonical(document.subjects || []);
  if (document.kind === 'ValidatingAdmissionPolicy') {
    return holds(live.spec, document.spec) && ['matchConditions', 'variables', 'validations', 'paramKind', 'auditAnnotations']
      .every((key) => canonical(live.spec?.[key] ?? null) === canonical(document.spec[key] ?? null));
  }
  if (document.kind === 'ValidatingAdmissionPolicyBinding') {
    return live.spec?.policyName === document.spec.policyName && live.spec?.paramRef === undefined
      && canonical(live.spec?.validationActions) === canonical(document.spec.validationActions)
      && (!live.spec?.matchResources || Object.keys(live.spec.matchResources).every((k) => k === 'matchPolicy' || canonical(live.spec.matchResources[k]) === '{}'));
  }
  if (document.webhooks) {
    // The operator writes the CA bundle; everything Setup declares must hold.
    const strip = (w) => ({ ...w, clientConfig: { ...w.clientConfig, caBundle: undefined } });
    return holds(live.webhooks?.map(strip), document.webhooks.map(strip));
  }
  if (document.kind === 'ConfigMap') return canonical(live.data || {}) === canonical(document.data || {});
  if (document.kind === 'Namespace' || document.kind === 'ServiceAccount') return true;
  return holds(live.spec, document.spec);
}

export function createConsoleDbClient(context, runner = run) {
  if (typeof context !== 'string' || !context || context.startsWith('-') || /\s/.test(context)) throw fail('INVALID_SCOPE', 'Explicit Kubernetes context required');
  return (args, options = {}) => runner('kubectl', ['--context', context, ...args], { capture: true, ...options });
}

export function discoverApi(k) {
  const read = (args) => JSON.parse(k([...args, '-o', 'json', '--request-timeout=10s']));
  return kubernetesApiPeers(read(['-n', 'default', 'get', 'service', 'kubernetes']),
    read(['-n', 'default', 'get', 'endpointslices.discovery.k8s.io', '-l', 'kubernetes.io/service-name=kubernetes']));
}
export function ciliumServed(k) {
  const out = String(k(['get', 'customresourcedefinition', 'ciliumnetworkpolicies.cilium.io', '--ignore-not-found', '-o', 'name', '--request-timeout=10s']) || '').trim();
  return out.length > 0;
}

const list = (items) => `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items })}\n`;
function observe(k, documents) {
  const out = String(k(['get', '-f', '-', '--ignore-not-found', '-o', 'json', '--request-timeout=30s'], { input: list(documents) }) || '').trim();
  const found = out ? JSON.parse(out) : { items: [] };
  const live = new Map((found.kind === 'List' ? found.items : [found]).map((o) => [identity(o), o]));
  const objects = documents.map((d) => ({ identity: identity(d), status: !live.has(identity(d)) ? 'Missing' : objectMatches(d, live.get(identity(d))) ? 'Matching' : 'Differs' }));
  return { objects, live, missing: objects.filter((o) => o.status === 'Missing').length, differs: objects.filter((o) => o.status === 'Differs').length };
}

// The mode the live fence binding is in: warn (Warn+Audit, the emergency switch) or deny (also when absent).
export function liveFenceMode(k) {
  const out = String(k(['get', 'validatingadmissionpolicybinding', FENCE_NAME, '--ignore-not-found', '-o', 'json', '--request-timeout=10s']) || '').trim();
  const actions = out ? JSON.parse(out).spec?.validationActions || [] : [];
  return actions.includes('Deny') || !actions.length ? 'deny' : 'warn';
}

// fenceMode: deny | warn | preserve. preserve (Setup upgrade) keeps the mode the binding is in, so an upgrade never
// re-arms a fence an administrator switched to warn for an emergency (review finding 9).
export async function prepareConsoleDb({ context, apply = false, fenceMode = 'deny', runner = run, sleep = defaultSleep, attempts = 120, consecutive = 5, onProgress = () => {} } = {}) {
  const k = createConsoleDbClient(context, runner);
  if (fenceMode === 'preserve') fenceMode = liveFenceMode(k);
  const target = observeInstalledHissTarget(context, runner);
  const assertTarget = () => {
    if (JSON.stringify(observeInstalledHissTarget(context, runner)) !== JSON.stringify(target)) throw fail('PRECONDITION_FAILED', 'Installation or cluster changed; no further Console DB preparation writes');
  };
  const missingNamespaces = [DATA_NAMESPACE].filter((n) => !String(k(['get', 'namespace', n, '--ignore-not-found', '-o', 'name', '--request-timeout=10s']) || '').trim());
  if (missingNamespaces.length) return { state: 'Blocked', reason: 'NamespacesMissing', missing: missingNamespaces, applied: false };
  const api = discoverApi(k);
  const cilium = ciliumServed(k);
  const rendered = renderOperatorObjects({ api, cilium, fenceMode });
  const phases = [['fence', rendered.fence], ['crds', rendered.crds], ['network', rendered.network], ['operator', rendered.operator]];
  const all = phases.flatMap(([, docs]) => docs);
  const before = observe(k, all);
  const summary = { target: { clusterUid: target.clusterUid, installationUid: target.installationUid }, images: rendered.images, fenceMode, cilium,
    apiServerSources: api.sources, droppedChartObjects: rendered.dropped, resourceCount: all.length };
  if (!apply) {
    return { ...summary, state: before.missing ? 'NeedsPreparation' : before.differs ? 'NeedsUpdate' : 'Present', applied: false,
      missing: before.missing, differs: before.differs, objects: before.objects.filter((o) => o.status !== 'Matching') };
  }
  const ssa = (docs) => k(['apply', '--server-side', `--field-manager=${FIELD_MANAGER}`, '-f', '-', '--request-timeout=60s'], { input: list(docs) });
  const readBack = (docs, phase) => {
    const after = observe(k, docs);
    if (after.missing || after.differs) throw fail('PREPARATION_INCOMPLETE', `Console DB operator objects (${phase}) do not read back as applied`,
      { objects: after.objects.filter((o) => o.status !== 'Matching') });
  };
  for (const [phase, docs] of phases) {
    assertTarget();
    ssa(docs);
    readBack(docs, phase);
    onProgress({ phase, objects: docs.length });
    if (phase === 'fence') {
      for (let attempt = 1; ; attempt += 1) {
        const p = JSON.parse(k(['get', 'validatingadmissionpolicy', FENCE_NAME, '-o', 'json', '--request-timeout=10s']));
        if (p.status?.observedGeneration === p.metadata?.generation && !(p.status?.typeChecking?.expressionWarnings || []).length) break;
        if (attempt >= attempts) throw fail('PREPARATION_INCOMPLETE', 'The operator fence is not type-checked without warnings; nothing else was applied');
        sleep(500);
      }
    }
    if (phase === 'crds') {
      k(['wait', '--for=condition=Established', '--timeout=120s', ...docs.map((d) => `crd/${d.metadata.name}`)]);
    }
  }
  k(['-n', OPERATOR_NAMESPACE, 'rollout', 'status', `deployment/${OPERATOR_SERVICE_ACCOUNT}`, '--timeout=300s']);
  const deployment = JSON.parse(k(['-n', OPERATOR_NAMESPACE, 'get', 'deployment', OPERATOR_SERVICE_ACCOUNT, '-o', 'json']));
  if (deployment.status?.readyReplicas !== 2) throw fail('PREPARATION_INCOMPLETE', 'The CloudNativePG operator is not Ready with 2 replicas');
  const proofs = proveConsoleDbFence(k, { fenceMode, sleep, attempts, consecutive });
  // Webhook reachability (M1): the operator's webhooks run on a server-side dry-run of the real Cluster manifest.
  const config = JSON.parse(JSON.parse(k(['-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock', '-o', 'json'])).data['config.json']);
  let webhook = 'unreachable';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      k(['create', '-f', '-', '--dry-run=server', '-o', 'name', '--request-timeout=20s'], { input: `${JSON.stringify(renderConsoleDbCluster({ storageClass: config.storageClass }))}\n` });
      webhook = 'answered';
      break;
    } catch (error) {
      if (/already exists/i.test(String(error?.stderr || error?.message))) { webhook = 'answered'; break; }
      sleep(1000);
    }
  }
  if (webhook !== 'answered') throw fail('PREPARATION_INCOMPLETE', 'The CloudNativePG webhook did not answer a dry-run of the Console DB Cluster');
  return { ...summary, state: 'Applied', applied: true, created: before.missing, updated: before.differs, proofs: { ...proofs, webhook } };
}

// The fence on the live API servers. RBAC lets the operator do both requests below; only the fence can refuse them.
export function proveConsoleDbFence(k, { fenceMode = 'deny', sleep = defaultSleep, attempts = 60, consecutive = 5 } = {}) {
  if (fenceMode !== 'deny') return { secretProbe: 'skipped (warn mode)', pvcProbe: 'skipped (warn mode)' };
  const probe = (args, input) => {
    let denied = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        k([...args, '--dry-run=server', '--as', OPERATOR_USER, '--request-timeout=10s'], input === undefined ? {} : { input });
        denied = 0;
      } catch (error) {
        const text = String(error?.stderr || error?.message || '');
        if (!text.includes(FENCE_NAME)) return `unavailable: ${text.split('\n').find((l) => l.trim()) || 'no message'}`;
        denied += 1;
        if (denied >= consecutive) return 'denied';
      }
      sleep(500);
    }
    return 'admitted';
  };
  const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'opensphere-setup-fence-probe', namespace: DATA_NAMESPACE }, stringData: { probe: 'not-stored' } };
  const secretProbe = probe(['create', '-f', '-', '-o', 'name'], `${JSON.stringify(secret)}\n`);
  if (secretProbe !== 'denied') throw fail('PREPARATION_INCOMPLETE', `The operator fence did not refuse a foreign Secret (${secretProbe}); do not create the Cluster`);
  const pvcExists = String(k(['-n', DATA_NAMESPACE, 'get', 'pvc', LEGACY_PVC, '--ignore-not-found', '-o', 'name']) || '').trim();
  const pvcProbe = pvcExists ? probe(['-n', DATA_NAMESPACE, 'delete', 'pvc', LEGACY_PVC]) : 'absent';
  if (pvcExists && pvcProbe !== 'denied') throw fail('PREPARATION_INCOMPLETE', `The operator fence did not refuse deleting ${LEGACY_PVC} (${pvcProbe})`);
  return { secretProbe, pvcProbe, cluster: CLUSTER_NAME };
}
