import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import {
  BOOTSTRAP_INITIALIZER_LIVE_PROFILE,
  canonicalAdmissionExpressionSha256,
} from './platform-release-bootstrap-manifest.mjs';

const NAMESPACE = 'opensphere-console';
const INITIALIZER = 'platform-release-tls-initializer';
const JOURNAL = 'opensphere-bootstrap-a-initializer-cleanup-journal';
const JOURNAL_CONTRACT = 'opensphere-bootstrap-a-initializer-cleanup-journal/v1';
export const CLEANUP_CONTRACT = 'opensphere-bootstrap-a-initializer-cleanup/v1';
const RETAINED_CONTRACT = 'opensphere-platform-release-authority-retained/v1';
const SERVICE_CUSTODY = 'opensphere-platform-release-authority-service-custody';
const JOURNAL_CUSTODY = 'opensphere-bootstrap-a-initializer-cleanup-journal-custody';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function resource(apiVersion, kind, namespace, name, plural) {
  return Object.freeze({ apiVersion, kind, namespace, name, plural });
}

export function bootstrapACleanupResourceSet(sourceRevision) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '')) {
    throw new Error('NeedsAttention: Bootstrap A source revision is invalid');
  }
  const resources = [
    resource('batch/v1', 'Job', NAMESPACE, `opensphere-tls-init-${sourceRevision}`, 'jobs'),
    resource('v1', 'ServiceAccount', NAMESPACE, INITIALIZER, 'serviceaccounts'),
    resource('rbac.authorization.k8s.io/v1', 'Role', NAMESPACE, INITIALIZER, 'roles'),
    resource('rbac.authorization.k8s.io/v1', 'RoleBinding', NAMESPACE, INITIALIZER, 'rolebindings'),
    resource('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-custody', 'validatingadmissionpolicies'),
    resource('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-custody', 'validatingadmissionpolicybindings'),
    resource('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-job-boundary', 'validatingadmissionpolicies'),
    resource('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-job-boundary', 'validatingadmissionpolicybindings'),
    resource('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-pod-boundary', 'validatingadmissionpolicies'),
    resource('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-pod-boundary', 'validatingadmissionpolicybindings'),
    resource('networking.k8s.io/v1', 'NetworkPolicy', NAMESPACE, INITIALIZER, 'networkpolicies'),
  ];
  return Object.freeze(resources.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right))));
}

function identity(descriptor, object) {
  const uid = String(object?.metadata?.uid || '');
  const resourceVersion = String(object?.metadata?.resourceVersion || '');
  if (!uid || !resourceVersion || object?.apiVersion !== descriptor.apiVersion
      || object?.kind !== descriptor.kind || object?.metadata?.name !== descriptor.name
      || String(object?.metadata?.namespace || '') !== descriptor.namespace) {
    throw new Error(`NeedsAttention: Bootstrap A cleanup resource identity drifted: ${descriptor.kind}/${descriptor.name}`);
  }
  return {
    apiVersion: descriptor.apiVersion,
    kind: descriptor.kind,
    namespace: descriptor.namespace,
    name: descriptor.name,
    uid,
    resourceVersion,
  };
}

function exactKeySet(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`NeedsAttention: ${label} has an unsupported field`);
  }
}

function empty(value) {
  return value === undefined || value === null
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    || value === '';
}

function exactPolicy(name, spec) {
  const expected = BOOTSTRAP_INITIALIZER_LIVE_PROFILE.policies[name];
  if (!expected) throw new Error(`NeedsAttention: unknown Bootstrap custody policy profile: ${name}`);
  exactKeySet(spec, [
    'failurePolicy','paramKind','matchConstraints','validations',
    'auditAnnotations','matchConditions','variables'
  ], `${name} policy`);
  if (spec.failurePolicy !== 'Fail' || canonicalJson(spec.paramKind) !== canonicalJson(expected.paramKind)
      || !empty(spec.auditAnnotations) || !empty(spec.matchConditions) || !empty(spec.variables)) {
    throw new Error(`NeedsAttention: Bootstrap custody policy drifted: ${name}`);
  }
  const constraints = spec.matchConstraints || {};
  exactKeySet(constraints, [
    'resourceRules','excludeResourceRules','matchPolicy','namespaceSelector','objectSelector'
  ], `${name} matchConstraints`);
  if (canonicalJson(constraints.resourceRules) !== canonicalJson(expected.resourceRules)
      || !empty(constraints.excludeResourceRules)
      || ![undefined, 'Equivalent'].includes(constraints.matchPolicy)
      || !empty(constraints.namespaceSelector) || !empty(constraints.objectSelector)) {
    throw new Error(`NeedsAttention: Bootstrap custody policy match drifted: ${name}`);
  }
  if (!Array.isArray(spec.validations) || spec.validations.length !== 1) {
    throw new Error(`NeedsAttention: Bootstrap custody policy validation count drifted: ${name}`);
  }
  const validation = spec.validations[0];
  exactKeySet(validation, ['expression','message','reason'], `${name} validation`);
  if (validation.message !== expected.message
      || ![undefined, 'Invalid'].includes(validation.reason)
      || canonicalAdmissionExpressionSha256(validation.expression) !== expected.expressionSha256) {
    throw new Error(`NeedsAttention: Bootstrap custody policy expression drifted: ${name}`);
  }
}

function exactBinding(name, spec) {
  const expected = BOOTSTRAP_INITIALIZER_LIVE_PROFILE.bindings[name];
  if (!expected) throw new Error(`NeedsAttention: unknown Bootstrap custody binding profile: ${name}`);
  exactKeySet(spec, ['policyName','paramRef','matchResources','validationActions'], `${name} binding`);
  if (spec.matchResources !== undefined) {
    exactKeySet(spec.matchResources, [
      'resourceRules','excludeResourceRules','matchPolicy','namespaceSelector','objectSelector'
    ], `${name} binding matchResources`);
    if (!empty(spec.matchResources.resourceRules) || !empty(spec.matchResources.excludeResourceRules)
        || ![undefined, 'Equivalent'].includes(spec.matchResources.matchPolicy)
        || !empty(spec.matchResources.namespaceSelector) || !empty(spec.matchResources.objectSelector)) {
      throw new Error(`NeedsAttention: Bootstrap custody binding match drifted: ${name}`);
    }
  }
  const normalized = {
    policyName: spec.policyName,
    ...(spec.paramRef === undefined ? {} : { paramRef: spec.paramRef }),
    validationActions: spec.validationActions,
  };
  if (canonicalJson(normalized) !== canonicalJson(expected)) {
    throw new Error(`NeedsAttention: Bootstrap custody binding drifted: ${name}`);
  }
}

function exactInitializerContainer(container, image) {
  exactKeySet(container, [
    'name','image','imagePullPolicy','command','args','env','envFrom','volumeMounts','volumeDevices',
    'resources','securityContext','ports','workingDir','lifecycle','livenessProbe','readinessProbe',
    'startupProbe','terminationMessagePath','terminationMessagePolicy','stdin','stdinOnce','tty'
  ], 'Bootstrap A initializer container');
  if (container.name !== 'initializer' || container.image !== image
      || container.imagePullPolicy !== 'IfNotPresent'
      || canonicalJson(container.command) !== canonicalJson([
        'node', '/app/opensphere-console-backend/platform-release-tls-initializer.mjs'
      ]) || !empty(container.args) || !empty(container.envFrom) || !empty(container.volumeDevices)
      || !empty(container.ports) || !empty(container.workingDir) || !empty(container.lifecycle)
      || !empty(container.livenessProbe) || !empty(container.readinessProbe)
      || !empty(container.startupProbe)
      || ![undefined, '/dev/termination-log'].includes(container.terminationMessagePath)
      || ![undefined, 'File'].includes(container.terminationMessagePolicy)
      || ![undefined, false].includes(container.stdin) || ![undefined, false].includes(container.stdinOnce)
      || ![undefined, false].includes(container.tty)) {
    throw new Error('NeedsAttention: Bootstrap A initializer container drifted');
  }
  if (canonicalJson(container.env) !== canonicalJson([
    { name: 'HOME', value: '/tmp/home' },
    { name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
    { name: 'PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE',
      value: 'opensphere-platform-release-tls-initializer/v1' },
  ])) throw new Error('NeedsAttention: Bootstrap A initializer environment drifted');
  const mounts = (container.volumeMounts || []).map((entry) => {
    exactKeySet(entry, ['name','mountPath','readOnly','subPath','subPathExpr','mountPropagation'],
      'Bootstrap A initializer volumeMount');
    if (!empty(entry.subPath) || !empty(entry.subPathExpr) || !empty(entry.mountPropagation)) {
      throw new Error('NeedsAttention: Bootstrap A initializer volumeMount drifted');
    }
    return { name: entry.name, mountPath: entry.mountPath, readOnly: entry.readOnly === true };
  });
  if (canonicalJson(mounts) !== canonicalJson([
    { name: 'kube-api-access', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true },
    { name: 'tmp', mountPath: '/tmp', readOnly: false },
  ]) || canonicalJson(container.resources?.requests) !== canonicalJson({ cpu: '20m', memory: '64Mi' })
      || canonicalJson(container.resources?.limits) !== canonicalJson({ cpu: '500m', memory: '256Mi' })
      || !empty(container.resources?.claims)) {
    throw new Error('NeedsAttention: Bootstrap A initializer mounts or resources drifted');
  }
  exactKeySet(container.resources || {}, ['requests','limits','claims'], 'Bootstrap A initializer resources');
  const security = container.securityContext || {};
  exactKeySet(security, [
    'runAsNonRoot','allowPrivilegeEscalation','readOnlyRootFilesystem','capabilities','privileged',
    'runAsUser','runAsGroup','procMount','seccompProfile'
  ], 'Bootstrap A initializer securityContext');
  if (security.runAsNonRoot !== true || security.allowPrivilegeEscalation !== false
      || security.readOnlyRootFilesystem !== true || ![undefined, false].includes(security.privileged)
      || !empty(security.runAsUser) || !empty(security.runAsGroup) || !empty(security.procMount)
      || !empty(security.seccompProfile)
      || canonicalJson(security.capabilities?.drop) !== canonicalJson(['ALL'])
      || !empty(security.capabilities?.add)
      || Object.keys(security.capabilities || {}).some((key) => !['drop','add'].includes(key))) {
    throw new Error('NeedsAttention: Bootstrap A initializer securityContext drifted');
  }
}

function exactInitializerJob(object, sourceRevision, image) {
  const spec = object.spec || {};
  exactKeySet(spec, [
    'parallelism','completions','completionMode','backoffLimit','activeDeadlineSeconds',
    'ttlSecondsAfterFinished','template','manualSelector','suspend','podReplacementPolicy','selector',
    'podFailurePolicy','successPolicy','backoffLimitPerIndex','maxFailedIndexes','managedBy'
  ], 'Bootstrap A initializer Job spec');
  if (canonicalJson(object.metadata?.labels) !== canonicalJson({
    app: INITIALIZER, 'opensphere.io/source-revision': sourceRevision,
  }) || spec.parallelism !== 1 || spec.completions !== 1 || spec.completionMode !== 'NonIndexed'
      || spec.backoffLimit !== 0 || spec.activeDeadlineSeconds !== 600
      || spec.ttlSecondsAfterFinished !== 86400 || ![undefined, false].includes(spec.manualSelector)
      || ![undefined, false].includes(spec.suspend)
      || ![undefined, 'TerminatingOrFailed'].includes(spec.podReplacementPolicy)
      || !empty(spec.podFailurePolicy) || !empty(spec.successPolicy)
      || !empty(spec.backoffLimitPerIndex) || !empty(spec.maxFailedIndexes) || !empty(spec.managedBy)) {
    throw new Error('NeedsAttention: Bootstrap A initializer Job drifted');
  }
  if (spec.selector !== undefined) {
    exactKeySet(spec.selector, ['matchLabels','matchExpressions'], 'Bootstrap A initializer selector');
    const labels = spec.selector.matchLabels || {};
    if (Object.keys(labels).length !== 1 || !labels['batch.kubernetes.io/controller-uid']
        || !empty(spec.selector.matchExpressions)) {
      throw new Error('NeedsAttention: Bootstrap A initializer selector drifted');
    }
  }
  const template = spec.template || {};
  exactKeySet(template, ['metadata','spec'], 'Bootstrap A initializer Pod template');
  const templateLabels = template.metadata?.labels || {};
  const sourceLabels = { app: INITIALIZER, 'opensphere.io/source-revision': sourceRevision };
  for (const [key, value] of Object.entries(sourceLabels)) {
    if (templateLabels[key] !== value) throw new Error('NeedsAttention: Bootstrap A initializer template labels drifted');
  }
  const allowedTemplateLabels = new Set([
    ...Object.keys(sourceLabels), 'controller-uid','job-name',
    'batch.kubernetes.io/controller-uid','batch.kubernetes.io/job-name'
  ]);
  if (Object.keys(templateLabels).some((key) => !allowedTemplateLabels.has(key))
      || !empty(template.metadata?.annotations)) {
    throw new Error('NeedsAttention: Bootstrap A initializer template metadata drifted');
  }
  const selectorUid = spec.selector?.matchLabels?.['batch.kubernetes.io/controller-uid'];
  if (selectorUid) {
    const expectedControllerLabels = {
      'controller-uid': selectorUid,
      'batch.kubernetes.io/controller-uid': selectorUid,
      'job-name': object.metadata.name,
      'batch.kubernetes.io/job-name': object.metadata.name,
    };
    for (const [key, value] of Object.entries(expectedControllerLabels)) {
      if (templateLabels[key] !== value) {
        throw new Error('NeedsAttention: Bootstrap A initializer controller labels drifted');
      }
    }
  } else if (Object.keys(templateLabels).length !== Object.keys(sourceLabels).length) {
    throw new Error('NeedsAttention: Bootstrap A initializer template has unbound controller labels');
  }
  const pod = template.spec || {};
  exactKeySet(pod, [
    'serviceAccountName','serviceAccount','automountServiceAccountToken','restartPolicy','imagePullSecrets',
    'securityContext','containers','volumes','dnsPolicy','schedulerName','terminationGracePeriodSeconds',
    'enableServiceLinks','priority','preemptionPolicy','priorityClassName','hostNetwork','hostPID','hostIPC',
    'shareProcessNamespace','hostUsers','hostname','subdomain','setHostnameAsFQDN','nodeName','nodeSelector',
    'affinity','tolerations','topologySpreadConstraints','schedulingGates','hostAliases','runtimeClassName',
    'dnsConfig','readinessGates','resourceClaims','initContainers','ephemeralContainers'
  ], 'Bootstrap A initializer Pod spec');
  if (pod.serviceAccountName !== INITIALIZER || ![undefined, INITIALIZER].includes(pod.serviceAccount)
      || pod.automountServiceAccountToken !== false || pod.restartPolicy !== 'Never'
      || canonicalJson(pod.imagePullSecrets) !== canonicalJson([{ name: 'opensphere-ghcr-pull' }])
      || canonicalJson(pod.securityContext) !== canonicalJson({
        runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' }
      }) || ![undefined, 'ClusterFirst'].includes(pod.dnsPolicy)
      || ![undefined, 'default-scheduler'].includes(pod.schedulerName)
      || ![undefined, 30].includes(pod.terminationGracePeriodSeconds)
      || ![undefined, true].includes(pod.enableServiceLinks)
      || ![undefined, 0].includes(pod.priority)
      || ![undefined, 'PreemptLowerPriority'].includes(pod.preemptionPolicy)
      || ![undefined, true].includes(pod.hostUsers)
      || ![undefined, false].includes(pod.hostNetwork) || ![undefined, false].includes(pod.hostPID)
      || ![undefined, false].includes(pod.hostIPC) || ![undefined, false].includes(pod.shareProcessNamespace)
      || ![undefined, false].includes(pod.setHostnameAsFQDN)
      || !empty(pod.priorityClassName) || !empty(pod.hostname) || !empty(pod.subdomain)
      || !empty(pod.nodeName) || !empty(pod.nodeSelector) || !empty(pod.affinity)
      || !empty(pod.tolerations) || !empty(pod.topologySpreadConstraints) || !empty(pod.schedulingGates)
      || !empty(pod.hostAliases) || !empty(pod.runtimeClassName) || !empty(pod.dnsConfig)
      || !empty(pod.readinessGates) || !empty(pod.resourceClaims) || !empty(pod.initContainers)
      || !empty(pod.ephemeralContainers) || pod.containers?.length !== 1) {
    throw new Error('NeedsAttention: Bootstrap A initializer Pod boundary drifted');
  }
  const volumes = pod.volumes || [];
  if (volumes.length !== 2 || volumes[0]?.name !== 'kube-api-access' || volumes[1]?.name !== 'tmp') {
    throw new Error('NeedsAttention: Bootstrap A initializer volumes drifted');
  }
  exactKeySet(volumes[0], ['name','projected'], 'Bootstrap A initializer projected volume');
  exactKeySet(volumes[0].projected || {}, ['defaultMode','sources'], 'Bootstrap A initializer projection');
  const sources = volumes[0].projected?.sources || [];
  if (volumes[0].projected?.defaultMode !== 256 || sources.length !== 2
      || canonicalJson(sources[0]) !== canonicalJson({ serviceAccountToken: {
        path: 'token', audience: 'https://kubernetes.default.svc', expirationSeconds: 600
      } }) || sources[1]?.configMap?.name !== 'kube-root-ca.crt'
      || canonicalJson(sources[1]?.configMap?.items) !== canonicalJson([{ key: 'ca.crt', path: 'ca.crt' }])
      || ![undefined, false].includes(sources[1]?.configMap?.optional)) {
    throw new Error('NeedsAttention: Bootstrap A initializer projected identity drifted');
  }
  exactKeySet(volumes[1], ['name','emptyDir'], 'Bootstrap A initializer tmp volume');
  if (!empty(volumes[1].emptyDir)) throw new Error('NeedsAttention: Bootstrap A initializer tmp volume drifted');
  exactInitializerContainer(pod.containers[0], image);
}

function exactInitializerObject(descriptor, object, bootstrapFrom) {
  identity(descriptor, object);
  const sourceRevision = bootstrapFrom.sourceRevision;
  const spec = object.spec || {};
  if (descriptor.kind === 'Job') {
    exactInitializerJob(object, sourceRevision, bootstrapFrom.image);
  } else if (descriptor.kind === 'ServiceAccount') {
    exactKeySet(object, ['apiVersion','kind','metadata','automountServiceAccountToken','secrets','imagePullSecrets'],
      'Bootstrap A initializer ServiceAccount');
    if (object.automountServiceAccountToken !== false || !empty(object.secrets) || !empty(object.imagePullSecrets)) {
      throw new Error('NeedsAttention: Bootstrap A initializer ServiceAccount drifted');
    }
  } else if (descriptor.kind === 'Role') {
    if (canonicalJson(object.rules) !== canonicalJson(BOOTSTRAP_INITIALIZER_LIVE_PROFILE.roleRules))
      throw new Error('NeedsAttention: Bootstrap A initializer Role drifted');
  } else if (descriptor.kind === 'RoleBinding') {
    if (canonicalJson({ roleRef: object.roleRef, subjects: object.subjects })
        !== canonicalJson(BOOTSTRAP_INITIALIZER_LIVE_PROFILE.roleBinding)) {
      throw new Error('NeedsAttention: Bootstrap A initializer RoleBinding drifted');
    }
  } else if (descriptor.kind === 'ValidatingAdmissionPolicy') {
    exactPolicy(descriptor.name, spec);
  } else if (descriptor.kind === 'ValidatingAdmissionPolicyBinding') {
    exactBinding(descriptor.name, spec);
  } else if (descriptor.kind === 'NetworkPolicy') {
    if (canonicalJson(object.spec) !== canonicalJson(BOOTSTRAP_INITIALIZER_LIVE_PROFILE.networkPolicySpec)) {
      throw new Error('NeedsAttention: Bootstrap A initializer NetworkPolicy drifted');
    }
  }
  return true;
}

function marked(object) {
  const name = String(object?.metadata?.name || '');
  return name.startsWith('opensphere-tls-init-') || name.startsWith(INITIALIZER)
    || object?.metadata?.labels?.app === INITIALIZER;
}

async function scanResidues(client, descriptors, bootstrapFrom, { requireComplete, expectedJobIdentity }) {
  const sourceRevision = bootstrapFrom.sourceRevision;
  const expected = new Map(descriptors.map((entry) => [`${entry.kind}/${entry.name}`, entry]));
  const found = new Map();
  const listKinds = [...new Map(descriptors.map((entry) => [entry.kind, entry])).values()];
  for (const descriptor of listKinds) {
    for (const object of await client.list(descriptor)) {
      if (!marked(object)) continue;
      const key = `${object.kind}/${object.metadata?.name}`;
      const match = expected.get(key);
      if (!match) throw new Error(`NeedsAttention: unexpected Bootstrap A initializer residue: ${key}`);
      exactInitializerObject(match, object, bootstrapFrom);
      found.set(key, object);
    }
  }
  const podDescriptor = resource('v1', 'Pod', NAMESPACE, '', 'pods');
  const job = found.get(`Job/opensphere-tls-init-${sourceRevision}`);
  const jobName = `opensphere-tls-init-${sourceRevision}`;
  const jobUid = job?.metadata?.uid ?? expectedJobIdentity?.uid;
  const pods = (await client.list(podDescriptor)).filter(marked);
  if (pods.length > 1) throw new Error('NeedsAttention: multiple Bootstrap A initializer Pods exist');
  for (const pod of pods) {
    const owner = pod.metadata?.ownerReferences?.[0];
    if (!jobUid || pod.metadata?.ownerReferences?.length !== 1 || owner?.apiVersion !== 'batch/v1'
        || owner?.kind !== 'Job' || owner?.name !== jobName || owner?.uid !== jobUid
        || owner?.controller !== true || pod.metadata?.labels?.app !== INITIALIZER
        || pod.metadata?.labels?.['opensphere.io/source-revision'] !== sourceRevision) {
      throw new Error('NeedsAttention: Bootstrap A initializer Pod ownership drifted');
    }
  }
  if (requireComplete && found.size !== descriptors.length) {
    const missing = descriptors.filter((entry) => !found.has(`${entry.kind}/${entry.name}`));
    throw new Error(`NeedsAttention: Bootstrap A cleanup set is missing: ${missing.map((entry) => `${entry.kind}/${entry.name}`).join(', ')}`);
  }
  return { found, pods };
}

function requireRetainedObject(object, apiVersion, kind, name) {
  if (object?.apiVersion !== apiVersion || object?.kind !== kind || object?.metadata?.name !== name
      || !object.metadata?.uid || !object.metadata?.resourceVersion) {
    throw new Error(`NeedsAttention: retained authority object is missing or drifted: ${kind}/${name}`);
  }
  return object;
}

function exactAuthorityService(service) {
  const spec = service.spec || {};
  exactKeySet(spec, [
    'selector','ports','type','clusterIP','clusterIPs','ipFamilies','ipFamilyPolicy',
    'internalTrafficPolicy','sessionAffinity','sessionAffinityConfig','publishNotReadyAddresses',
    'externalIPs','externalName','loadBalancerClass','loadBalancerIP','externalTrafficPolicy',
    'healthCheckNodePort','allocateLoadBalancerNodePorts','trafficDistribution'
  ], 'retained Platform Release authority Service');
  const port = spec.ports?.[0];
  if (canonicalJson(service.metadata?.labels) !== canonicalJson({ app: 'opensphere-platform-release-authority' })
      || canonicalJson(spec.selector) !== canonicalJson({ app: 'opensphere-console-backend' })
      || spec.type !== 'ClusterIP' || !spec.clusterIP || spec.clusterIP === 'None'
      || canonicalJson(spec.clusterIPs) !== canonicalJson([spec.clusterIP])
      || !Array.isArray(spec.ipFamilies) || spec.ipFamilies.length !== 1
      || spec.ipFamilyPolicy !== 'SingleStack' || spec.internalTrafficPolicy !== 'Cluster'
      || spec.sessionAffinity !== 'None' || !empty(spec.sessionAffinityConfig)
      || !empty(spec.externalIPs) || !empty(spec.externalName) || !empty(spec.loadBalancerClass)
      || !empty(spec.loadBalancerIP) || ![undefined, 'Cluster'].includes(spec.externalTrafficPolicy)
      || ![undefined, 0].includes(spec.healthCheckNodePort)
      || ![undefined, false].includes(spec.publishNotReadyAddresses)
      || ![undefined, false].includes(spec.allocateLoadBalancerNodePorts)
      || !empty(spec.trafficDistribution) || spec.ports?.length !== 1) {
    throw new Error('NeedsAttention: retained Platform Release authority Service drifted');
  }
  exactKeySet(port || {}, ['name','port','protocol','targetPort','appProtocol','nodePort'],
    'retained Platform Release authority Service port');
  if (port?.name !== 'https' || port.port !== 8446 || port.protocol !== 'TCP'
      || port.targetPort !== 'release-tls' || !empty(port.appProtocol)
      || ![undefined, 0].includes(port.nodePort)) {
    throw new Error('NeedsAttention: retained Platform Release authority Service port drifted');
  }
}

async function retainedAuthority(client, authority) {
  const retainedDescriptors = {
    secret: resource('v1', 'Secret', NAMESPACE,
      'opensphere-platform-release-authority-tls', 'secrets'),
    configMap: resource('v1', 'ConfigMap', NAMESPACE,
      'opensphere-platform-release-control-ca', 'configmaps'),
    service: resource('v1', 'Service', NAMESPACE,
      'opensphere-platform-release-authority', 'services'),
  };
  const live = {};
  for (const [key, descriptor] of Object.entries(retainedDescriptors)) {
    const observed = requireRetainedObject(await client.get(descriptor), descriptor.apiVersion,
      descriptor.kind, descriptor.name);
    const verified = requireRetainedObject(authority?.[key], descriptor.apiVersion,
      descriptor.kind, descriptor.name);
    if (observed.metadata.uid !== verified.metadata.uid
        || observed.metadata.resourceVersion !== verified.metadata.resourceVersion) {
      throw new Error(`NeedsAttention: retained authority re-read differs: ${descriptor.kind}/${descriptor.name}`);
    }
    live[key] = observed;
  }
  const secret = live.secret;
  const ca = live.configMap;
  const service = live.service;
  const policyDescriptor = resource('admissionregistration.k8s.io/v1',
    'ValidatingAdmissionPolicy', '', SERVICE_CUSTODY, 'validatingadmissionpolicies');
  const bindingDescriptor = resource('admissionregistration.k8s.io/v1',
    'ValidatingAdmissionPolicyBinding', '', SERVICE_CUSTODY, 'validatingadmissionpolicybindings');
  const policy = requireRetainedObject(await client.get(policyDescriptor), policyDescriptor.apiVersion,
    policyDescriptor.kind, policyDescriptor.name);
  const binding = requireRetainedObject(await client.get(bindingDescriptor), bindingDescriptor.apiVersion,
    bindingDescriptor.kind, bindingDescriptor.name);
  exactPolicy(SERVICE_CUSTODY, policy.spec);
  exactBinding(SERVICE_CUSTODY, binding.spec);
  exactAuthorityService(service);
  const caBytes = Buffer.from(String(secret.data?.['ca.crt'] || ''), 'base64');
  const certBytes = Buffer.from(String(secret.data?.['tls.crt'] || ''), 'base64');
  if (!caBytes.length || !certBytes.length) throw new Error('NeedsAttention: retained TLS evidence is absent');
  return {
    contract: RETAINED_CONTRACT,
    secretUid: secret.metadata.uid,
    secretResourceVersion: secret.metadata.resourceVersion,
    caConfigMapUid: ca.metadata.uid,
    caConfigMapResourceVersion: ca.metadata.resourceVersion,
    serviceUid: service.metadata.uid,
    serviceResourceVersion: service.metadata.resourceVersion,
    caCertSha256: digest(caBytes),
    tlsCertSha256: digest(certBytes),
    serviceCustodyPolicyUid: policy.metadata.uid,
    serviceCustodyPolicyResourceVersion: policy.metadata.resourceVersion,
    serviceCustodyBindingUid: binding.metadata.uid,
    serviceCustodyBindingResourceVersion: binding.metadata.resourceVersion,
  };
}

function journalDescriptor() {
  return resource('v1', 'ConfigMap', NAMESPACE, JOURNAL, 'configmaps');
}

function validateJournal(object, expected) {
  requireRetainedObject(object, 'v1', 'ConfigMap', JOURNAL);
  if (object.immutable !== true
      || canonicalJson(object.metadata?.labels) !== canonicalJson({
        'opensphere.io/purpose': 'bootstrap-a-initializer-cleanup-journal'
      }) || Object.keys(object.data || {}).sort().join(',') !== 'journal.json') {
    throw new Error('NeedsAttention: Bootstrap A cleanup journal metadata drifted');
  }
  const raw = String(object.data['journal.json'] || '');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('NeedsAttention: Bootstrap A cleanup journal is invalid JSON'); }
  if (raw !== canonicalJson(parsed) || canonicalJson(parsed) !== canonicalJson(expected)) {
    throw new Error('NeedsAttention: Bootstrap A cleanup journal differs from the requested transaction');
  }
  return { object, raw, parsed };
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`NeedsAttention: Bootstrap A cleanup journal ${label} shape drifted`);
  }
}

function validateJournalPayload(parsed, descriptors) {
  exactKeys(parsed, [
    'contract','bootstrapRequestId','bootstrapSourceRevision','targetReleaseDigest',
    'cleanupSetDigest','deletedResources','retainedAuthority','journalCustody'
  ], 'top-level');
  exactKeys(parsed.retainedAuthority, [
    'contract','secretUid','secretResourceVersion','caConfigMapUid','caConfigMapResourceVersion',
    'serviceUid','serviceResourceVersion','caCertSha256','tlsCertSha256',
    'serviceCustodyPolicyUid','serviceCustodyPolicyResourceVersion',
    'serviceCustodyBindingUid','serviceCustodyBindingResourceVersion'
  ], 'retainedAuthority');
  exactKeys(parsed.journalCustody, [
    'policyUid','policyResourceVersion','bindingUid','bindingResourceVersion'
  ], 'journalCustody');
  if (!Array.isArray(parsed.deletedResources) || parsed.deletedResources.length !== 11) {
    throw new Error('NeedsAttention: Bootstrap A cleanup journal deletedResources shape drifted');
  }
  const expected = new Map(descriptors.map((entry) => [`${entry.kind}/${entry.name}`, entry]));
  const seen = new Set();
  for (const entry of parsed.deletedResources) {
    exactKeys(entry, ['apiVersion','kind','namespace','name','uid','resourceVersion'],
      'deleted resource');
    const key = `${entry.kind}/${entry.name}`;
    const descriptor = expected.get(key);
    if (!descriptor || seen.has(key) || entry.apiVersion !== descriptor.apiVersion
        || entry.namespace !== descriptor.namespace || !entry.uid || !entry.resourceVersion) {
      throw new Error('NeedsAttention: Bootstrap A cleanup journal deleted resource identity drifted');
    }
    seen.add(key);
  }
  if (seen.size !== descriptors.length
      || canonicalJson([...parsed.deletedResources].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)))) !== canonicalJson(parsed.deletedResources)) {
    throw new Error('NeedsAttention: Bootstrap A cleanup journal resources are not canonical and unique');
  }
}

async function validatePermanentJournalCustody(client) {
  const proof = {};
  for (const [kind, plural] of [
    ['ValidatingAdmissionPolicy', 'validatingadmissionpolicies'],
    ['ValidatingAdmissionPolicyBinding', 'validatingadmissionpolicybindings'],
  ]) {
    const descriptor = resource('admissionregistration.k8s.io/v1', kind, '', JOURNAL_CUSTODY, plural);
    const object = requireRetainedObject(await client.get(descriptor), descriptor.apiVersion, kind, descriptor.name);
    if (kind === 'ValidatingAdmissionPolicy') {
      exactPolicy(JOURNAL_CUSTODY, object.spec);
      proof.policyUid = object.metadata.uid;
      proof.policyResourceVersion = object.metadata.resourceVersion;
    } else {
      exactBinding(JOURNAL_CUSTODY, object.spec);
      proof.bindingUid = object.metadata.uid;
      proof.bindingResourceVersion = object.metadata.resourceVersion;
    }
  }
  return proof;
}

async function exactRetainedReread(client, retained) {
  const checks = [
    [resource('v1', 'Secret', NAMESPACE, 'opensphere-platform-release-authority-tls', 'secrets'),
      retained.secretUid, retained.secretResourceVersion],
    [resource('v1', 'ConfigMap', NAMESPACE, 'opensphere-platform-release-control-ca', 'configmaps'),
      retained.caConfigMapUid, retained.caConfigMapResourceVersion],
    [resource('v1', 'Service', NAMESPACE, 'opensphere-platform-release-authority', 'services'),
      retained.serviceUid, retained.serviceResourceVersion],
    [resource('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '', SERVICE_CUSTODY,
      'validatingadmissionpolicies'), retained.serviceCustodyPolicyUid,
    retained.serviceCustodyPolicyResourceVersion],
    [resource('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '', SERVICE_CUSTODY,
      'validatingadmissionpolicybindings'), retained.serviceCustodyBindingUid,
    retained.serviceCustodyBindingResourceVersion],
  ];
  for (const [descriptor, uid, resourceVersion] of checks) {
    const object = await client.get(descriptor);
    if (object?.metadata?.uid !== uid || object?.metadata?.resourceVersion !== resourceVersion) {
      throw new Error(`NeedsAttention: retained authority changed during cleanup: ${descriptor.kind}/${descriptor.name}`);
    }
  }
}

function apiPath(descriptor) {
  const prefix = descriptor.apiVersion === 'v1' ? '/api/v1' : `/apis/${descriptor.apiVersion}`;
  const namespace = descriptor.namespace ? `/namespaces/${encodeURIComponent(descriptor.namespace)}` : '';
  const name = descriptor.name ? `/${encodeURIComponent(descriptor.name)}` : '';
  return `${prefix}${namespace}/${descriptor.plural}${name}`;
}

export async function createInClusterKubernetesClient({
  environment = process.env,
  readFileFn = readFile,
  requestFn = httpsRequest,
} = {}) {
  const host = String(environment.KUBERNETES_SERVICE_HOST || '');
  const port = Number.parseInt(environment.KUBERNETES_SERVICE_PORT_HTTPS || '443', 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('NeedsAttention: exact in-cluster Kubernetes API endpoint is unavailable');
  }
  const [token, ca] = await Promise.all([
    readFileFn('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8'),
    readFileFn('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
  ]);
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = requestFn({
      hostname: host, port, path, method, ca, rejectUnauthorized: true,
      servername: 'kubernetes.default.svc',
      headers: {
        authorization: `Bearer ${String(token).trim()}`,
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode === 404 && method === 'GET') return resolve(null);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`Kubernetes ${method} ${path} failed with ${response.statusCode}: ${raw}`));
        }
        resolve(raw ? JSON.parse(raw) : null);
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
  return {
    get: (descriptor) => call('GET', apiPath(descriptor)),
    list: async (descriptor) => (await call('GET', apiPath({ ...descriptor, name: '' })))?.items || [],
    create: (descriptor, object) => call('POST', apiPath({ ...descriptor, name: '' }), object),
    delete: (descriptor, preconditions) => call('DELETE', apiPath(descriptor), {
      apiVersion: 'v1', kind: 'DeleteOptions',
      propagationPolicy: descriptor.kind === 'Job' ? 'Foreground' : 'Background',
      preconditions: { uid: preconditions.uid, resourceVersion: preconditions.resourceVersion },
    }),
  };
}

async function deleteExact(client, descriptor, precondition, sleep) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const current = await client.get(descriptor);
    if (!current) return;
    if (current.metadata?.uid !== precondition.uid) {
      throw new Error(`NeedsAttention: cleanup precondition drifted: ${descriptor.kind}/${descriptor.name}`);
    }
    if (current.metadata?.deletionTimestamp) {
      await sleep(100);
      continue;
    }
    if (current.metadata?.resourceVersion !== precondition.resourceVersion) {
      throw new Error(`NeedsAttention: cleanup precondition drifted: ${descriptor.kind}/${descriptor.name}`);
    }
    try { await client.delete(descriptor, precondition); } catch { /* exact re-read resolves response loss */ }
    const reread = await client.get(descriptor);
    if (!reread) return;
    if (reread.metadata?.uid !== precondition.uid) {
      throw new Error(`NeedsAttention: cleanup response-loss reread drifted: ${descriptor.kind}/${descriptor.name}`);
    }
    if (reread.metadata?.deletionTimestamp) {
      await sleep(100);
      continue;
    }
    if (reread.metadata?.resourceVersion !== precondition.resourceVersion) {
      throw new Error(`NeedsAttention: cleanup response-loss reread drifted: ${descriptor.kind}/${descriptor.name}`);
    }
    await sleep(100);
  }
  throw new Error(`NeedsAttention: exact cleanup delete did not converge: ${descriptor.kind}/${descriptor.name}`);
}

export async function cleanupBootstrapAInitializer({
  bootstrapFrom,
  targetReleaseDigest,
  authority,
  client,
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!bootstrapFrom || !/^[0-9a-f-]{36}$/i.test(bootstrapFrom.requestId ?? '')
      || !/^ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}$/
        .test(bootstrapFrom.image ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(targetReleaseDigest ?? '')) {
    throw new Error('NeedsAttention: Bootstrap A cleanup transaction binding is invalid');
  }
  const kube = client ?? await createInClusterKubernetesClient();
  const descriptors = bootstrapACleanupResourceSet(bootstrapFrom.sourceRevision);
  const journalCustody = await validatePermanentJournalCustody(kube);
  const retained = await retainedAuthority(kube, authority);
  const journalInfo = await kube.get(journalDescriptor());
  let deletedResources;
  let cleanupSetDigest;
  let expectedJournal;
  if (journalInfo) {
    const raw = String(journalInfo.data?.['journal.json'] || '');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('NeedsAttention: Bootstrap A cleanup journal is invalid JSON'); }
    expectedJournal = parsed;
    validateJournalPayload(parsed, descriptors);
    if (parsed.contract !== JOURNAL_CONTRACT || parsed.bootstrapRequestId !== bootstrapFrom.requestId
        || parsed.bootstrapSourceRevision !== bootstrapFrom.sourceRevision
        || parsed.targetReleaseDigest !== targetReleaseDigest
        || canonicalJson(parsed.retainedAuthority) !== canonicalJson(retained)
        || canonicalJson(parsed.journalCustody) !== canonicalJson(journalCustody)
        || !Array.isArray(parsed.deletedResources) || parsed.deletedResources.length !== 11) {
      throw new Error('NeedsAttention: Bootstrap A cleanup journal transaction binding drifted');
    }
    deletedResources = parsed.deletedResources;
    cleanupSetDigest = digest(canonicalJson(deletedResources));
    if (parsed.cleanupSetDigest !== cleanupSetDigest) {
      throw new Error('NeedsAttention: Bootstrap A cleanup journal set digest drifted');
    }
    validateJournal(journalInfo, parsed);
    const expectedJobIdentity = deletedResources.find((entry) => entry.kind === 'Job');
    await scanResidues(kube, descriptors, bootstrapFrom,
      { requireComplete: false, expectedJobIdentity });
  } else {
    const { found } = await scanResidues(kube, descriptors, bootstrapFrom,
      { requireComplete: true });
    deletedResources = descriptors.map((descriptor) =>
      identity(descriptor, found.get(`${descriptor.kind}/${descriptor.name}`)))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    cleanupSetDigest = digest(canonicalJson(deletedResources));
    expectedJournal = {
      contract: JOURNAL_CONTRACT,
      bootstrapRequestId: bootstrapFrom.requestId,
      bootstrapSourceRevision: bootstrapFrom.sourceRevision,
      targetReleaseDigest,
      cleanupSetDigest,
      deletedResources,
      retainedAuthority: retained,
      journalCustody,
    };
    validateJournalPayload(expectedJournal, descriptors);
    const object = {
      apiVersion: 'v1', kind: 'ConfigMap', immutable: true,
      metadata: { name: JOURNAL, namespace: NAMESPACE,
        labels: { 'opensphere.io/purpose': 'bootstrap-a-initializer-cleanup-journal' } },
      data: { 'journal.json': canonicalJson(expectedJournal) },
    };
    try { await kube.create(journalDescriptor(), object); } catch { /* response loss resolved below */ }
    validateJournal(await kube.get(journalDescriptor()), expectedJournal);
  }
  const preconditions = new Map(deletedResources.map((entry) =>
    [`${entry.kind}/${entry.name}`, entry]));
  const expectedJobIdentity = deletedResources.find((entry) => entry.kind === 'Job');
  for (const descriptor of descriptors) {
    const precondition = preconditions.get(`${descriptor.kind}/${descriptor.name}`);
    if (!precondition || precondition.apiVersion !== descriptor.apiVersion
        || precondition.namespace !== descriptor.namespace) {
      throw new Error(`NeedsAttention: cleanup journal lacks exact precondition: ${descriptor.kind}/${descriptor.name}`);
    }
    await deleteExact(kube, descriptor, precondition, sleep);
  }
  let residueCount = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { found, pods } = await scanResidues(kube, descriptors, bootstrapFrom,
      { requireComplete: false, expectedJobIdentity });
    residueCount = found.size + pods.length;
    if (residueCount === 0) break;
    await sleep(50);
  }
  if (residueCount !== 0) throw new Error(`NeedsAttention: Bootstrap A initializer residue count is ${residueCount}`);
  await exactRetainedReread(kube, retained);
  if (canonicalJson(await validatePermanentJournalCustody(kube)) !== canonicalJson(journalCustody)) {
    throw new Error('NeedsAttention: Bootstrap A cleanup journal custody changed during cleanup');
  }
  const journal = validateJournal(await kube.get(journalDescriptor()), expectedJournal);
  return {
    contract: CLEANUP_CONTRACT,
    bootstrapRequestId: bootstrapFrom.requestId,
    bootstrapSourceRevision: bootstrapFrom.sourceRevision,
    targetReleaseDigest,
    cleanupSetDigest,
    deletedResources,
    retainedAuthority: retained,
    journalCustody,
    journalUid: journal.object.metadata.uid,
    journalResourceVersion: journal.object.metadata.resourceVersion,
    journalSha256: digest(journal.raw),
    residueCount: 0,
    completedAt: now().toISOString(),
  };
}
