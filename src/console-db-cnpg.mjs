// R2-C2: the Console database (Supabase PostgreSQL) on CloudNativePG.
//
// Approved in the RKE2 readiness stage plan (2026-10-24, §3 R2-C2, §4.1 "CNPG"), confirmed 2026-10-27. Design:
// HA-AND-NODE-FAILURE-DESIGN-20261024.md §1 (option A). Lab and the ten design breaks: R2-C2-CNPG-LAB-RESULTS-20261027.md.
// Vulnerability conditions M1-M6: R2-C2-CNPG-VULN-TRIAGE-20261027.md.
//
// The CloudNativePG operator is a Setup base component (Console Backbone), not a HISS facility: Setup must be able to
// stand up and recover the Console on its own (ADR-0017). This module owns
//   - the operator objects, rendered from the pinned upstream chart bytes (console-db-cnpg-operator-artifact.json);
//   - the admission fence that confines the operator to its own Cluster's objects in opensphere-console-data;
//   - the NetworkPolicies (and CiliumNetworkPolicies where Cilium serves them) for the operator and the instances;
//   - the Console DB Cluster manifest;
//   - how Setup finds the database it runs SQL on, in either layout (the StatefulSet before the cutover, the CNPG
//     primary after it).
// The cutover itself is console-db-cutover.mjs.
import { createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import images from './console-db-cnpg-images.json' with { type: 'json' };
import operatorArtifact from './console-db-cnpg-operator-artifact.json' with { type: 'json' };
import { registryKubernetesEgress } from './registry-runtime-access.mjs';

export const DATA_NAMESPACE = 'opensphere-console-data';
export const OPERATOR_NAMESPACE = 'opensphere-cnpg-system';
export const OPERATOR_SERVICE_ACCOUNT = 'cnpg-cloudnative-pg';
export const OPERATOR_USER = `system:serviceaccount:${OPERATOR_NAMESPACE}:${OPERATOR_SERVICE_ACCOUNT}`;
export const CLUSTER_NAME = 'opensphere-console-db';
export const CONSOLE_DB_SERVICE = 'opensphere-supabase-postgres';
export const LEGACY_STATEFULSET = 'opensphere-supabase-postgres';
export const LEGACY_PVC = 'opensphere-supabase-postgres-data';
export const LEGACY_SOURCE_SERVICE = 'opensphere-supabase-postgres-legacy';
export const SUPABASE_SECRET = 'opensphere-supabase-secrets';
export const ADMIN_SECRET = `${CLUSTER_NAME}-supabase-admin`;
export const IMPORT_SOURCE_SECRET = `${CLUSTER_NAME}-import-source`;
export const CUTOVER_CONFIGMAP = `${CLUSTER_NAME}-cutover`;
export const FENCE_NAME = 'opensphere-console-db-operator-fence';
export const FIELD_MANAGER = 'opensphere-setup-console-db';
export const AUTHORITY = 'console-db-cnpg-v1';
export const OPERATOR_ARTIFACT_SHA256 = 'a5e30523c586b16aa580d492564208f2ea0591b6dff7a1dcf98cb7b24b25dff9';
export const OPERATOR_ARTIFACT_OBJECTS = 24;
const WEBHOOK_CONFIGURATIONS = Object.freeze(['cnpg-mutating-webhook-configuration', 'cnpg-validating-webhook-configuration']);
const OPERATOR_LABELS = Object.freeze({ 'app.kubernetes.io/name': 'cloudnative-pg', 'app.kubernetes.io/instance': 'cnpg' });
const INSTANCE_LABELS = Object.freeze({ 'cnpg.io/cluster': CLUSTER_NAME });
// The Console NetworkPolicies select the database by these Pod labels (Console target/deploy.yaml). The CNPG instances
// inherit them, so console-api, OS Shell, R2D2 and the Supabase services reach the new primary under the same rules.
export const INHERITED_LABELS = Object.freeze({ app: 'opensphere-supabase-postgres', 'opensphere.io/supabase-component': 'data-identity' });
export const PRIMARY_SELECTOR = Object.freeze({ app: 'opensphere-supabase-postgres', 'cnpg.io/instanceRole': 'primary' });
export const LEGACY_SELECTOR = Object.freeze({ app: 'opensphere-supabase-postgres' });
const OWN_NAME = `^${CLUSTER_NAME}(-[a-z0-9.-]+)?$`;
const SETUP_LABELS = Object.freeze({
  'app.kubernetes.io/part-of': 'opensphere-console',
  'app.kubernetes.io/managed-by': 'opensphere-setup',
  'opensphere.io/authority': AUTHORITY,
});

const fail = (code, message, evidence) => Object.assign(new Error(message), { code, ...(evidence ? { evidence } : {}) });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const canonical = (v) => JSON.stringify(sorted(v));
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------------------------------------------------
// Images (M5): tag and digest, from console-db-cnpg-images.json only.
// Upstream, or an unmodified digest-preserving copy under ghcr.io/opensphere-platform/mirror/ (the StackGres mirror
// precedent): RKE2's Console image-integrity policy admits Jobs in opensphere-console-data only from
// ghcr.io/opensphere-platform unless the Console release exempts the operator (docs/CONSOLE-DB-CNPG.md §7, X11).
const IMAGE_PATTERN = {
  operator: /^ghcr\.io\/(?:opensphere-platform\/mirror\/)?cloudnative-pg\/cloudnative-pg:[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]{64}$/,
  // The Console database stays on PostgreSQL 17 (the installed major); a major upgrade is a separate migration.
  postgres: /^ghcr\.io\/(?:opensphere-platform\/mirror\/)?cloudnative-pg\/postgresql:17\.[0-9]+-[0-9]{12}-standard-[a-z]+@sha256:[a-f0-9]{64}$/,
};
export function consoleDbImages(source = images) {
  for (const key of ['operator', 'postgres']) {
    if (!IMAGE_PATTERN[key].test(source?.[key] ?? '')) throw fail('UNTRUSTED_PROFILE', `CNPG ${key} image must be pinned by tag and digest`);
  }
  return Object.freeze({ operator: source.operator, postgres: source.postgres });
}
// A pinned image as Kubernetes may report it: the tag+digest reference, or the repository with the digest only.
export function imageForms(reference) {
  const [repository] = reference.split(':');
  return [reference, `${repository}@${reference.split('@')[1]}`];
}

// ---------------------------------------------------------------------------------------------------------------------
// Operator objects from the chart bytes.
export function verifyOperatorArtifact(artifact = operatorArtifact) {
  if (typeof artifact?.yaml !== 'string' || sha256(artifact.yaml) !== OPERATOR_ARTIFACT_SHA256) {
    throw fail('UNTRUSTED_PROFILE', 'CloudNativePG chart render differs from the pinned bytes');
  }
  if (artifact.source?.version !== '0.29.1' || artifact.source?.appVersion !== '1.30.1') throw fail('UNTRUSTED_PROFILE', 'Unexpected CloudNativePG chart');
  const documents = parseAllDocuments(artifact.yaml).map((d) => d.toJSON()).filter(Boolean);
  if (documents.length !== OPERATOR_ARTIFACT_OBJECTS) throw fail('UNTRUSTED_PROFILE', 'CloudNativePG chart render envelope differs');
  return documents;
}

function relabel(document) {
  const labels = { ...(document.metadata.labels || {}) };
  delete labels['helm.sh/chart'];
  delete labels['app.kubernetes.io/managed-by'];
  document.metadata.labels = { ...labels, ...SETUP_LABELS };
  return document;
}

// The chart's namespaced "common" rules, bound in the watched namespace. Writes the Console DB never uses (Pooler
// Deployments, PodMonitors, VolumeSnapshots) are cut back to reads: the controllers still watch those kinds, so the
// reads stay. Everything else the operator writes there passes the admission fence below.
export function watchedNamespaceRules(chartRules) {
  const readOnly = new Map([['apps', 'deployments'], ['monitoring.coreos.com', 'podmonitors'], ['snapshot.storage.k8s.io', 'volumesnapshots']]);
  return chartRules.map((rule) => {
    const group = rule.apiGroups?.[0];
    if (rule.apiGroups?.length === 1 && rule.resources?.length === 1 && readOnly.get(group) === rule.resources[0]) {
      return { ...rule, verbs: ['get', 'list', 'watch'] };
    }
    return rule;
  });
}

// The operator's own namespace (lab 2026-10-27 §4.2): leader lease, webhook certificate Secret, config maps, webhook
// Service, events; its own Deployment (owner of the webhook certificate) and EndpointSlices are read.
export const OPERATOR_NAMESPACE_RULES = Object.freeze([
  { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['create', 'get', 'list', 'update', 'watch'] },
  { apiGroups: [''], resources: ['secrets', 'configmaps', 'services'], verbs: ['create', 'get', 'list', 'patch', 'update', 'watch'] },
  { apiGroups: [''], resources: ['events'], verbs: ['create', 'patch'] },
  { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list', 'watch'] },
]);

function operatorDeployment(document, image) {
  const d = clone(document);
  d.spec.replicas = 2;
  const pod = d.spec.template.spec;
  const c = pod.containers[0];
  c.image = image;
  for (const e of c.env) {
    if (e.name === 'WATCH_NAMESPACE') e.value = DATA_NAMESPACE;
    // The image the operator injects into every instance Pod (bootstrap-controller and instance manager).
    if (e.name === 'OPERATOR_IMAGE_NAME') e.value = image;
  }
  if (!c.env.some((e) => e.name === 'WATCH_NAMESPACE' && e.value === DATA_NAMESPACE)) throw fail('UNTRUSTED_PROFILE', 'Operator Deployment has no WATCH_NAMESPACE');
  c.resources = { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '1Gi' } };
  pod.topologySpreadConstraints = [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'DoNotSchedule',
    labelSelector: { matchLabels: { ...OPERATOR_LABELS } } }];
  return d;
}

const ref = (cidr) => ({ ipBlock: { cidr } });
const tcp = (...ports) => ports.map((port) => ({ protocol: 'TCP', port }));

// The API server as NetworkPolicy peers: egress to the Service VIP and every ready endpoint (both sides of the DNAT,
// the registry-runtime-access rule), and the endpoint addresses alone as the source of webhook calls (M1).
export function kubernetesApiPeers(service, slices) {
  const egress = registryKubernetesEgress(service, slices);
  const vips = new Set((service.spec?.clusterIPs || [service.spec?.clusterIP]).map((ip) => `${ip}/${ip.includes(':') ? 128 : 32}`));
  const sources = [...new Set(egress.map((rule) => rule.to[0].ipBlock.cidr).filter((cidr) => !vips.has(cidr)))].sort();
  if (!sources.length) throw fail('OBSERVATION_UNAVAILABLE', 'No ready Kubernetes API endpoint to admit webhook calls from');
  const ports = [...new Set(egress.map((rule) => rule.ports[0].port))].sort((a, b) => a - b);
  return { egress, sources, ports };
}

export function renderNetworkPolicies({ api, cilium }) {
  const policies = [
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'opensphere-cnpg-default-deny', namespace: OPERATOR_NAMESPACE },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] } },
    // M1: webhook 9443 only from the API server, metrics 8080 only from Prometheus; egress only to the API server and
    // the instances' status (8000) and PostgreSQL (5432) ports.
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'opensphere-cnpg-operator', namespace: OPERATOR_NAMESPACE },
      spec: { podSelector: { matchLabels: { ...OPERATOR_LABELS } }, policyTypes: ['Ingress', 'Egress'],
        ingress: [
          { from: api.sources.map(ref), ports: tcp(9443) },
          { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus' } } }], ports: tcp(8080) },
        ],
        egress: [...clone(api.egress),
          { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': DATA_NAMESPACE } }, podSelector: { matchLabels: { ...INSTANCE_LABELS } } }],
            ports: tcp(8000, 5432) }] } },
    // M2: the instance policy the lab validated (scripts/31-cnpg-networkpolicy.yaml), with the API server discovered.
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: `${CLUSTER_NAME}-cnpg`, namespace: DATA_NAMESPACE },
      spec: { podSelector: { matchLabels: { ...INSTANCE_LABELS } }, policyTypes: ['Ingress', 'Egress'],
        ingress: [
          { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': OPERATOR_NAMESPACE } }, podSelector: { matchLabels: { ...OPERATOR_LABELS } } }],
            ports: tcp(8000, 5432) },
          { from: [{ podSelector: { matchLabels: { ...INSTANCE_LABELS } } }], ports: tcp(8000, 5432) },
        ],
        egress: [...clone(api.egress), { to: [{ podSelector: { matchLabels: { ...INSTANCE_LABELS } } }], ports: tcp(8000, 5432) }] } },
  ];
  if (cilium) {
    // CIDR peers do not select node-hosted API servers under Cilium (the console-api precedent), so each policy that
    // names the API server gets a same-named CiliumNetworkPolicy with the kube-apiserver entity.
    const apiPorts = [{ ports: api.ports.map((port) => ({ port: String(port), protocol: 'TCP' })) }];
    policies.push(
      { apiVersion: 'cilium.io/v2', kind: 'CiliumNetworkPolicy', metadata: { name: 'opensphere-cnpg-operator', namespace: OPERATOR_NAMESPACE },
        spec: { endpointSelector: { matchLabels: { ...OPERATOR_LABELS } },
          ingress: [{ fromEntities: ['kube-apiserver'], toPorts: [{ ports: [{ port: '9443', protocol: 'TCP' }] }] }],
          egress: [{ toEntities: ['kube-apiserver'], toPorts: apiPorts }] } },
      { apiVersion: 'cilium.io/v2', kind: 'CiliumNetworkPolicy', metadata: { name: `${CLUSTER_NAME}-cnpg`, namespace: DATA_NAMESPACE },
        spec: { endpointSelector: { matchLabels: { ...INSTANCE_LABELS } }, egress: [{ toEntities: ['kube-apiserver'], toPorts: apiPorts }] } },
    );
  }
  return policies.map(relabel);
}

// ---------------------------------------------------------------------------------------------------------------------
// The admission fence (user decision 2026-10-27): the operator may write only its own Cluster's objects in
// opensphere-console-data, never another Secret, and nothing cluster-wide except the CA bundle of its two webhook
// configurations. Bound to the operator's ServiceAccount only. Every resource is matched with wildcards and the policy
// allows a closed list, so a kind the operator has never written is refused rather than silently passed.
// What a ValidatingAdmissionPolicy cannot do: refuse reads. The operator still reads every Secret in the namespace
// (CNPG watches Secrets); that residual risk is recorded with the plan.
const quoted = (list) => `[${list.map((x) => `'${x}'`).join(', ')}]`;
const own = (expression) => `${expression}.matches('${OWN_NAME}')`;
const sameField = (field) => `(has(w.${field}) == has(o.${field}) && (!has(w.${field}) || w.${field} == o.${field}))`;
const WEBHOOK_FIELDS = ['clientConfig.service', 'clientConfig.url', 'rules', 'failurePolicy', 'matchPolicy', 'namespaceSelector',
  'objectSelector', 'sideEffects', 'timeoutSeconds', 'admissionReviewVersions', 'matchConditions', 'reinvocationPolicy'];
export const FENCE_RESOURCES = Object.freeze([
  'pods', 'pods/exec', 'services', 'secrets', 'configmaps', 'persistentvolumeclaims', 'serviceaccounts', 'events', 'jobs',
  'poddisruptionbudgets', 'leases', 'roles', 'rolebindings',
  'clusters', 'clusters/status', 'clusters/finalizers', 'failoverquorums', 'failoverquorums/status',
  'backups', 'backups/status', 'scheduledbackups', 'scheduledbackups/status', 'poolers', 'poolers/status', 'poolers/finalizers',
  'databases', 'databases/status', 'publications', 'publications/status', 'subscriptions', 'subscriptions/status',
  'databaseroles', 'databaseroles/status', 'databaseroles/finalizers',
]);
export const INSTANCE_ROLE_RESOURCES = Object.freeze([
  'secrets', 'configmaps', 'events', 'leases', 'clusters', 'clusters/status', 'backups', 'backups/status', 'databases', 'databases/status',
  'publications', 'publications/status', 'subscriptions', 'subscriptions/status', 'failoverquorums', 'failoverquorums/status',
  'databaseroles', 'databaseroles/status',
]);

export function renderFence({ images: pinned = consoleDbImages(), mode = 'deny' } = {}) {
  if (!['deny', 'warn'].includes(mode)) throw fail('INVALID_INPUT', 'Operator fence mode is deny or warn');
  const allowedImages = [...imageForms(pinned.operator), ...imageForms(pinned.postgres)];
  const container = 'c.image in variables.images'
    + ' && !(has(c.securityContext) && ((has(c.securityContext.privileged) && c.securityContext.privileged)'
    + ' || (has(c.securityContext.allowPrivilegeEscalation) && c.securityContext.allowPrivilegeEscalation)'
    + ' || (has(c.securityContext.capabilities) && has(c.securityContext.capabilities.add) && size(c.securityContext.capabilities.add) > 0)))'
    + ' && !(has(c.ports) && c.ports.exists(p, has(p.hostPort) && p.hostPort != 0))'
    + ` && (!has(c.env) || c.env.all(e, !has(e.valueFrom) || ((!has(e.valueFrom.secretKeyRef) || ${own('e.valueFrom.secretKeyRef.name')})`
    + ` && (!has(e.valueFrom.configMapKeyRef) || ${own('e.valueFrom.configMapKeyRef.name')}))))`
    + ` && (!has(c.envFrom) || c.envFrom.all(f, (!has(f.secretRef) || ${own('f.secretRef.name')}) && (!has(f.configMapRef) || ${own('f.configMapRef.name')})))`;
  const volume = `has(v.persistentVolumeClaim) ? ${own('v.persistentVolumeClaim.claimName')}`
    + ` : (has(v.emptyDir) || has(v.downwardAPI) || (has(v.secret) && ${own('v.secret.secretName')})`
    + ` || (has(v.configMap) && (${own('v.configMap.name')} || v.configMap.name in ['cnpg-default-monitoring', 'kube-root-ca.crt']))`
    + " || (has(v.projected) && v.projected.sources.all(p, has(p.serviceAccountToken) || has(p.downwardAPI) || (has(p.configMap) && p.configMap.name == 'kube-root-ca.crt'))))";
  const podSpec = `variables.spec.serviceAccountName == '${CLUSTER_NAME}'`
    + ' && !(has(variables.spec.hostNetwork) && variables.spec.hostNetwork) && !(has(variables.spec.hostPID) && variables.spec.hostPID)'
    + ' && !(has(variables.spec.hostIPC) && variables.spec.hostIPC) && !has(variables.spec.ephemeralContainers)'
    + ` && variables.containers.all(c, ${container})`
    + ` && (!has(variables.spec.volumes) || variables.spec.volumes.all(v, ${volume}))`
    + ` && has(variables.podLabels) && 'cnpg.io/cluster' in variables.podLabels && variables.podLabels['cnpg.io/cluster'] == '${CLUSTER_NAME}'`;
  const roleRule = "!r.verbs.exists(v, v in ['*', 'escalate', 'bind', 'impersonate'])"
    + " && r.apiGroups.all(g, g in ['', 'postgresql.cnpg.io', 'coordination.k8s.io']) && !has(r.nonResourceURLs)"
    + ` && r.resources.all(x, x in ${quoted(INSTANCE_ROLE_RESOURCES)})`
    + " && (!r.resources.exists(x, x in ['secrets', 'configmaps']) || (has(r.resourceNames) && size(r.resourceNames) > 0"
    + ` && r.resourceNames.all(n, ${own('n')} || n == 'cnpg-default-monitoring')))`;
  const webhookUnchanged = `size(object.webhooks) == size(oldObject.webhooks) && object.webhooks.all(w, oldObject.webhooks.exists(o, o.name == w.name && ${WEBHOOK_FIELDS.map(sameField).join(' && ')}))`;
  const writes = "request.operation in ['CREATE', 'UPDATE']";
  const policy = {
    apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy',
    metadata: { name: FENCE_NAME },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: {
        // Namespaced writes only in the watched namespace; cluster-scoped writes always reach the policy.
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': DATA_NAMESPACE } },
        resourceRules: [{ apiGroups: ['*'], apiVersions: ['*'], operations: ['CREATE', 'UPDATE', 'DELETE', 'CONNECT'], resources: ['*/*'] }],
      },
      matchConditions: [{ name: 'cnpg-operator', expression: `request.userInfo.username == '${OPERATOR_USER}'` }],
      variables: [
        // Absent request fields are absent keys in CEL (a cluster-scoped request has no namespace).
        { name: 'ns', expression: "has(request.namespace) ? request.namespace : ''" },
        { name: 'sub', expression: "has(request.subResource) ? request.subResource : ''" },
        { name: 'name', expression: "has(request.name) ? request.name : ''" },
        { name: 'res', expression: "request.resource.resource + (variables.sub != '' ? '/' + variables.sub : '')" },
        { name: 'images', expression: quoted(allowedImages) },
        { name: 'spec', expression: "variables.res == 'pods' ? object.spec : object.spec.template.spec" },
        { name: 'podLabels', expression: "variables.res == 'pods' ? object.metadata.labels : object.spec.template.metadata.labels" },
        { name: 'containers', expression: 'variables.spec.containers + (has(variables.spec.initContainers) ? variables.spec.initContainers : [])' },
      ],
      validations: [
        { expression: `variables.ns != '' || (request.resource.group == 'admissionregistration.k8s.io' && variables.sub == ''`
            + " && request.resource.resource in ['mutatingwebhookconfigurations', 'validatingwebhookconfigurations'] && request.operation == 'UPDATE'"
            + ` && variables.name in ${quoted(WEBHOOK_CONFIGURATIONS)} && ${webhookUnchanged})`,
          message: 'The CloudNativePG operator may change only the CA bundle of its own two webhook configurations' },
        { expression: `variables.ns == '' || variables.res in ${quoted(FENCE_RESOURCES)}`,
          message: `The CloudNativePG operator may not write this kind of object in ${DATA_NAMESPACE}` },
        { expression: "request.operation != 'CONNECT' || variables.res == 'pods/exec'",
          message: 'The CloudNativePG operator may only exec into its own instance Pods' },
        { expression: `variables.ns == '' || variables.res == 'events' || (variables.res == 'configmaps' && variables.name == 'cnpg-default-monitoring') || ${own('variables.name')}`,
          message: `The CloudNativePG operator may write only the objects of Cluster ${CLUSTER_NAME}` },
        { expression: `!(variables.res == 'secrets' && variables.name in ${quoted([ADMIN_SECRET, IMPORT_SOURCE_SECRET])})`,
          message: 'The Setup-owned Console DB Secrets are read-only for the CloudNativePG operator' },
        { expression: `!(${writes} && variables.res in ['pods', 'jobs']) || (${podSpec})`,
          message: 'The CloudNativePG operator may run only the pinned images, as the instance ServiceAccount, without host access or privilege, mounting only its own volumes and Secrets' },
        { expression: `!(${writes} && variables.res == 'services') || ((!has(object.spec.type) || object.spec.type == 'ClusterIP')`
            + ' && (!has(object.spec.externalIPs) || size(object.spec.externalIPs) == 0)'
            + ` && has(object.spec.selector) && 'cnpg.io/cluster' in object.spec.selector && object.spec.selector['cnpg.io/cluster'] == '${CLUSTER_NAME}')`,
          message: 'The CloudNativePG operator may expose only ClusterIP Services that select its own instances' },
        { expression: `!(${writes} && variables.res == 'poddisruptionbudgets') || (has(object.spec.selector.matchLabels) && 'cnpg.io/cluster' in object.spec.selector.matchLabels`
            + ` && object.spec.selector.matchLabels['cnpg.io/cluster'] == '${CLUSTER_NAME}')`,
          message: 'The CloudNativePG operator may write only PodDisruptionBudgets for its own instances' },
        { expression: `!(variables.res in ['serviceaccounts', 'roles', 'rolebindings']) || variables.name == '${CLUSTER_NAME}'`,
          message: `The CloudNativePG operator may write only the instance identity ${CLUSTER_NAME}` },
        { expression: `!(${writes} && variables.res == 'serviceaccounts') || !has(object.imagePullSecrets) || object.imagePullSecrets.all(s, ${own('s.name')})`,
          message: 'The instance ServiceAccount may reference only its own pull Secrets' },
        { expression: `!(${writes} && variables.res == 'roles') || object.rules.all(r, ${roleRule})`,
          message: 'The instance Role may name only its own Secrets and ConfigMaps and the CloudNativePG resources' },
        { expression: `!(${writes} && variables.res == 'rolebindings') || (object.roleRef.kind == 'Role' && object.roleRef.name == '${CLUSTER_NAME}'`
            + ` && size(object.subjects) == 1 && object.subjects[0].kind == 'ServiceAccount' && object.subjects[0].name == '${CLUSTER_NAME}'`
            + ` && (!has(object.subjects[0].namespace) || object.subjects[0].namespace == '${DATA_NAMESPACE}'))`,
          message: 'The instance RoleBinding may bind only the instance Role to the instance ServiceAccount' },
        { expression: `variables.res != 'clusters' || (request.operation == 'UPDATE' && object.spec == oldObject.spec)`,
          message: 'The CloudNativePG operator may not create, delete or change the specification of a Cluster' },
      ],
    },
  };
  const binding = {
    apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicyBinding',
    metadata: { name: FENCE_NAME },
    spec: { policyName: FENCE_NAME, validationActions: mode === 'deny' ? ['Deny'] : ['Warn', 'Audit'] },
  };
  return [relabel(policy), relabel(binding)];
}

// ---------------------------------------------------------------------------------------------------------------------
export function renderOperatorObjects({ api, cilium = false, fenceMode = 'deny', artifact = operatorArtifact, imageSource = images } = {}) {
  const pinned = consoleDbImages(imageSource);
  const chart = verifyOperatorArtifact(artifact);
  const pick = (kind, name) => {
    const found = chart.filter((d) => d.kind === kind && (!name || d.metadata.name === name));
    if (found.length !== 1) throw fail('UNTRUSTED_PROFILE', `Chart object ${kind}/${name ?? '*'} is not unique`);
    return clone(found[0]);
  };
  const namespace = relabel({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: OPERATOR_NAMESPACE, labels: {
    'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'latest',
    'pod-security.kubernetes.io/warn': 'restricted', 'pod-security.kubernetes.io/audit': 'restricted' } } });
  const crds = chart.filter((d) => d.kind === 'CustomResourceDefinition').map(clone);
  if (crds.length !== 11) throw fail('UNTRUSTED_PROFILE', 'Expected the 11 CloudNativePG CRDs');
  const config = pick('ConfigMap', 'cnpg-controller-manager-config');
  config.data = { ...config.data, WATCH_NAMESPACE: DATA_NAMESPACE };
  const clusterRole = pick('ClusterRole', OPERATOR_SERVICE_ACCOUNT);
  clusterRole.rules = clusterRole.rules.map((rule) => (rule.apiGroups?.[0] === 'admissionregistration.k8s.io'
    ? { ...rule, resourceNames: [...WEBHOOK_CONFIGURATIONS] } : rule));
  const chartRole = pick('Role', OPERATOR_SERVICE_ACCOUNT);
  const subject = { kind: 'ServiceAccount', name: OPERATOR_SERVICE_ACCOUNT, namespace: OPERATOR_NAMESPACE };
  const roleRef = (kind, name) => ({ apiGroup: 'rbac.authorization.k8s.io', kind, name });
  const objects = {
    fence: [namespace, ...renderFence({ images: pinned, mode: fenceMode })],
    crds,
    network: renderNetworkPolicies({ api, cilium }),
    operator: [
      pick('ServiceAccount', OPERATOR_SERVICE_ACCOUNT),
      config,
      pick('ConfigMap', 'cnpg-default-monitoring'),
      clusterRole,
      pick('ClusterRoleBinding', OPERATOR_SERVICE_ACCOUNT),
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: OPERATOR_SERVICE_ACCOUNT, namespace: DATA_NAMESPACE },
        rules: watchedNamespaceRules(chartRole.rules) },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: OPERATOR_SERVICE_ACCOUNT, namespace: DATA_NAMESPACE },
        roleRef: roleRef('Role', OPERATOR_SERVICE_ACCOUNT), subjects: [subject] },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: `${OPERATOR_SERVICE_ACCOUNT}-self`, namespace: OPERATOR_NAMESPACE },
        rules: clone(OPERATOR_NAMESPACE_RULES) },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: `${OPERATOR_SERVICE_ACCOUNT}-self`, namespace: OPERATOR_NAMESPACE },
        roleRef: roleRef('Role', `${OPERATOR_SERVICE_ACCOUNT}-self`), subjects: [subject] },
      pick('Service', 'cnpg-webhook-service'),
      pick('MutatingWebhookConfiguration'),
      pick('ValidatingWebhookConfiguration'),
      operatorDeployment(pick('Deployment'), pinned.operator),
    ],
  };
  // Everything namespaced in the chart goes to the operator namespace unless placed above.
  for (const d of [...objects.crds, ...objects.operator]) {
    relabel(d);
    if (d.kind === 'RoleBinding' || d.kind === 'Role' || d.kind === 'CustomResourceDefinition') continue;
    if (['ClusterRole', 'ClusterRoleBinding', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'].includes(d.kind)) continue;
    d.metadata.namespace = OPERATOR_NAMESPACE;
  }
  // The chart's aggregated view/edit ClusterRoles are left out: they would grant every namespace editor CNPG rights.
  const dropped = chart.filter((d) => d.kind === 'ClusterRole' && d.metadata.name !== OPERATOR_SERVICE_ACCOUNT).map((d) => d.metadata.name);
  return { ...objects, dropped, images: pinned };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Console DB Cluster (lab scripts/30-cnpg-cluster.yaml, design §1.3, lab breaks X1-X5, X9).
export function renderConsoleDbCluster({ storageClass, imageSource = images, instances = 3 } = {}) {
  if (typeof storageClass !== 'string' || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(storageClass)) throw fail('INVALID_INPUT', 'Installation StorageClass is required');
  const pinned = consoleDbImages(imageSource);
  return relabel({
    apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster',
    metadata: { name: CLUSTER_NAME, namespace: DATA_NAMESPACE },
    spec: {
      instances,
      imageName: pinned.postgres,
      imagePullPolicy: 'IfNotPresent',
      enableSuperuserAccess: false,
      primaryUpdateMethod: 'switchover',
      inheritedMetadata: { labels: { ...INHERITED_LABELS } },
      postgresql: {
        synchronous: { method: 'any', number: 1, dataDurability: 'preferred' },
        parameters: {
          max_connections: '200',
          password_encryption: 'scram-sha-256',
          log_min_messages: 'warning',
          // Setting a pg_stat_statements parameter makes CNPG preload the library, as the source does.
          'pg_stat_statements.max': '5000',
        },
      },
      affinity: { enablePodAntiAffinity: true, podAntiAffinityType: 'required', topologyKey: 'kubernetes.io/hostname' },
      storage: { size: '20Gi', storageClass },
      resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } },
      managed: { roles: [{ name: 'supabase_admin', ensure: 'present', login: true, superuser: true, createdb: true, createrole: true,
        replication: true, bypassrls: true, inherit: true, passwordSecret: { name: ADMIN_SECRET } }] },
      bootstrap: { initdb: {
        // Same locale as the source database (ICU en-US, en_US.UTF-8); CNPG would otherwise create libc C (X9).
        encoding: 'UTF8', localeProvider: 'icu', icuLocale: 'en-US', localeCollate: 'en_US.UTF-8', localeCType: 'en_US.UTF-8',
        // supabase_admin is the Supabase image's bootstrap superuser (OID 10), which CNPG never imports (X1).
        postInitSQL: ['CREATE ROLE supabase_admin WITH SUPERUSER LOGIN CREATEDB CREATEROLE REPLICATION BYPASSRLS'],
        import: { type: 'monolith', databases: ['postgres'], roles: ['*'], source: { externalCluster: 'supabase-statefulset' },
          // Not in the CNPG image and unused by Console (user decision I1).
          pgDumpExtraOptions: ['--exclude-extension=supabase_vault'] },
      } },
      externalClusters: [{ name: 'supabase-statefulset',
        connectionParameters: { host: `${LEGACY_SOURCE_SERVICE}.${DATA_NAMESPACE}.svc.cluster.local`, port: '5432', user: 'supabase_admin', dbname: 'postgres', sslmode: 'disable' },
        password: { name: IMPORT_SOURCE_SECRET, key: 'password' } }],
    },
  });
}

// The import source: the CNPG Pods inherit the Console DB label, so the shared Service could reach a new instance (X5).
export function renderLegacySourceService() {
  return relabel({ apiVersion: 'v1', kind: 'Service', metadata: { name: LEGACY_SOURCE_SERVICE, namespace: DATA_NAMESPACE },
    spec: { selector: { 'statefulset.kubernetes.io/pod-name': `${LEGACY_STATEFULSET}-0` }, ports: [{ name: 'postgres', port: 5432, targetPort: 5432 }] } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Which database Setup talks to.
//   statefulset: the Console's Supabase StatefulSet (before the cutover, or after a rollback);
//   cnpg:        the CloudNativePG primary (the Service selects it);
//   cutover:     a cutover is between "writers stopped" and "writers back" -- nothing else may run SQL or apply.
const sameMap = (a, b) => canonical(a || {}) === canonical(b || {});
export function classifyConsoleDataLayout(service, cutoverConfigMap) {
  let cutover = null;
  if (cutoverConfigMap) {
    try { cutover = JSON.parse(cutoverConfigMap.data?.['state.json'] ?? 'null'); } catch { cutover = null; }
    if (!cutover?.state) throw fail('CONSOLE_DB_LAYOUT_UNKNOWN', `${CUTOVER_CONFIGMAP} is unreadable; inspect it before running Setup`);
  }
  if (cutover && ['InProgress', 'Switched'].includes(cutover.state)) return { layout: 'cutover', cutover };
  if (!service) return { layout: 'statefulset', cutover, fresh: true };
  const selector = service.spec?.selector;
  const port = (service.spec?.ports || []).find((p) => p.port === 5432);
  if (sameMap(selector, LEGACY_SELECTOR)) {
    if (cutover && ['Reopened', 'Completed'].includes(cutover.state)) throw fail('CONSOLE_DB_LAYOUT_UNKNOWN', 'The cutover record says CloudNativePG but the Service selects the StatefulSet');
    return { layout: 'statefulset', cutover };
  }
  if (sameMap(selector, PRIMARY_SELECTOR) && port?.targetPort === 5432) return { layout: 'cnpg', cutover };
  throw fail('CONSOLE_DB_LAYOUT_UNKNOWN', `Service ${CONSOLE_DB_SERVICE} selects neither the StatefulSet nor the CloudNativePG primary`);
}

// k(args, options) is a kubectl function (process.mjs kubectl, or a context-bound runner).
export function observeConsoleDataLayout(k) {
  const get = (args) => {
    const out = String(k([...args, '--ignore-not-found', '-o', 'json'], { capture: true }) || '').trim();
    return out ? JSON.parse(out) : null;
  };
  return classifyConsoleDataLayout(
    get(['-n', DATA_NAMESPACE, 'get', 'service', CONSOLE_DB_SERVICE]),
    get(['-n', DATA_NAMESPACE, 'get', 'configmap', CUTOVER_CONFIGMAP]),
  );
}

const readyPod = (pod) => pod.status?.phase === 'Running' && !pod.metadata?.deletionTimestamp
  && (pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');

// The Pod Setup runs SQL in, with how it runs it. Refuses during a cutover and when the view is ambiguous.
export function consoleDbTarget(k, purpose, { layout = observeConsoleDataLayout(k).layout } = {}) {
  if (layout === 'cutover') throw fail('CONSOLE_DB_CUTOVER', `${purpose}: a Console DB cutover is in progress; finish or roll it back first`);
  const list = (selector) => JSON.parse(k(['-n', DATA_NAMESPACE, 'get', 'pods', '-l', selector, '-o', 'json'], { capture: true })).items ?? [];
  if (layout === 'statefulset') {
    const ready = list('app=opensphere-supabase-postgres').filter(readyPod);
    if (ready.length !== 1) throw new Error(`${purpose} requires exactly one Ready Supabase PostgreSQL pod`);
    return { layout, pod: ready[0].metadata.name, container: 'postgres' };
  }
  const ready = list(`cnpg.io/cluster=${CLUSTER_NAME},cnpg.io/instanceRole=primary`).filter(readyPod);
  if (ready.length !== 1) throw new Error(`${purpose} requires exactly one Ready CloudNativePG primary`);
  const cluster = JSON.parse(k(['-n', DATA_NAMESPACE, 'get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME, '-o', 'json'], { capture: true }));
  if (cluster.status?.currentPrimary !== ready[0].metadata.name || cluster.status?.targetPrimary !== ready[0].metadata.name) {
    throw new Error(`${purpose}: the CloudNativePG primary is changing; retry after the switchover settles`);
  }
  return { layout, pod: ready[0].metadata.name, container: 'postgres' };
}

// Run SQL as supabase_admin, the owner of every Console object (design D3).
//   statefulset: TCP to 127.0.0.1 as supabase_admin with the Pod's own POSTGRES_PASSWORD (unchanged).
//   cnpg:        the local socket as postgres (peer authentication; no password in the Pod), then SET LOCAL ROLE
//                supabase_admin inside the transaction, so objects are owned by supabase_admin exactly as before
//                (lab §2.8). Reads use SET ROLE in their session.
export function consoleDbSql(k, target, sql, { transaction = false } = {}) {
  if (target.layout === 'statefulset') {
    const command = ['PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -h 127.0.0.1', '-U supabase_admin -d postgres -v ON_ERROR_STOP=1',
      transaction ? '--single-transaction' : '-tA'].join(' ');
    return k(['-n', DATA_NAMESPACE, 'exec', '-i', target.pod, '--', 'sh', '-ec', command], { capture: true, input: sql });
  }
  if (target.layout !== 'cnpg') throw fail('CONSOLE_DB_LAYOUT_UNKNOWN', 'Unknown Console DB layout');
  const prefix = transaction ? 'SET LOCAL ROLE supabase_admin;\n' : 'SET ROLE supabase_admin;\n';
  return k(['-n', DATA_NAMESPACE, 'exec', '-i', target.pod, '-c', target.container, '--',
    'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', transaction ? '--single-transaction' : '-tA'],
  { capture: true, input: prefix + sql });
}

// ---------------------------------------------------------------------------------------------------------------------
// The installed Console release decides how its installer treats the data layer. A release that predates the CNPG
// layout reapplies the StatefulSet (replicas 1) and the old Service selector, which would start the retired database
// beside the CNPG primary and point the Service at both. Setup therefore refuses such a release once the Console DB
// is on CNPG. The contract a CNPG-ready installer declares (Console-side change list, docs/CONSOLE-DB-CNPG.md §6):
//   param([ValidateSet('statefulset','cnpg')][string]$ConsoleDataLayout = 'statefulset')  in Install-ConsoleApiRuntime.ps1
export const CONSOLE_DATA_LAYOUT_PARAMETER = 'ConsoleDataLayout';
export function installerSupportsCnpgLayout(installerSource) {
  const param = /param\s*\(([\s\S]*?)\)\s*\r?\n\s*(?:Set-StrictMode|\$ErrorActionPreference|#|\$)/i.exec(String(installerSource || ''));
  const block = param ? param[1] : '';
  return new RegExp(`\\[ValidateSet\\('statefulset',\\s*'cnpg'\\)\\]\\s*\\[string\\]\\$${CONSOLE_DATA_LAYOUT_PARAMETER}\\b`, 'i').test(block);
}
export function assertReleaseFitsLayout(layout, { label, installerSource }) {
  if (layout === 'cutover') throw fail('CONSOLE_DB_CUTOVER', 'A Console DB cutover is in progress; finish or roll it back before any Setup apply');
  if (layout !== 'cnpg') return { layoutArguments: [] };
  if (!installerSupportsCnpgLayout(installerSource)) {
    throw fail('CONSOLE_DB_LAYOUT_UNSUPPORTED', `${label} predates the CloudNativePG Console DB layout; it would restart the retired StatefulSet. Use a Console release that declares -${CONSOLE_DATA_LAYOUT_PARAMETER}.`);
  }
  return { layoutArguments: [`-${CONSOLE_DATA_LAYOUT_PARAMETER}`, 'cnpg'] };
}

// The retired StatefulSet's objects are kept after the cutover (PV Retain, plan §4.3: deleted only after 7 days with a
// one-line notice). A Console release that no longer renders them must never prune them.
export const RETAINED_LEGACY_OBJECTS = Object.freeze([
  { kind: 'StatefulSet', namespace: DATA_NAMESPACE, name: LEGACY_STATEFULSET },
  { kind: 'PersistentVolumeClaim', namespace: DATA_NAMESPACE, name: LEGACY_PVC },
  { kind: 'ServiceAccount', namespace: DATA_NAMESPACE, name: LEGACY_STATEFULSET },
]);
export function isRetainedLegacyObject(resource) {
  return RETAINED_LEGACY_OBJECTS.some((r) => r.kind === resource.kind && r.namespace === resource.namespace && r.name === resource.name);
}

// Steady-state check of the live Cluster (verify, upgrade).
export function assertConsoleDbClusterHealthy(cluster, { storageClass, imageSource = images } = {}) {
  const pinned = consoleDbImages(imageSource);
  const s = cluster?.spec || {}, st = cluster?.status || {};
  const problems = [];
  if (s.instances !== 3) problems.push(`instances=${s.instances}`);
  if (s.imageName !== pinned.postgres) problems.push(`image ${s.imageName}`);
  // The API server adds defaults (failoverQuorum: false); the three fields Setup sets must hold.
  const sync = s.postgresql?.synchronous || {};
  if (sync.method !== 'any' || sync.number !== 1 || sync.dataDurability !== 'preferred') problems.push('synchronous replication differs');
  if (s.affinity?.podAntiAffinityType !== 'required') problems.push('anti-affinity is not required');
  if (storageClass && s.storage?.storageClass !== storageClass) problems.push(`StorageClass ${s.storage?.storageClass}`);
  if (st.readyInstances !== s.instances) problems.push(`ready ${st.readyInstances}/${s.instances}`);
  if (!st.currentPrimary || st.currentPrimary !== st.targetPrimary) problems.push('primary is changing');
  if (problems.length) throw fail('CONSOLE_DB_UNHEALTHY', `Console DB Cluster is not healthy: ${problems.join(', ')}`);
  return { instances: s.instances, readyInstances: st.readyInstances, primary: st.currentPrimary, image: s.imageName, phase: st.phase };
}

export { images as CONSOLE_DB_IMAGE_SOURCE };
