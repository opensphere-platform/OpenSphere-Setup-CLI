import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const BOOTSTRAP_MANIFEST_PROJECTION_CONTRACT =
  'opensphere-bootstrap-initializer-manifest-projection/v1';

const INITIALIZER = 'platform-release-tls-initializer';
const NAMESPACE = 'opensphere-console';

function documents(yaml) {
  return String(yaml).split(/^---\s*$/mu).map((entry) => entry.trim()).filter(Boolean);
}

function scalar(document, key) {
  const match = document.match(new RegExp(`^${key}:[ \\t]*["']?([^"'#{\\s]+)`, 'mu'));
  return match?.[1] || '';
}

function metadataValue(document, key) {
  const inline = document.match(/^metadata:\s*\{([^\n]+)\}\s*$/mu)?.[1] || '';
  const inlineMatch = inline.match(new RegExp(`(?:^|,)[ \\t]*${key}:[ \\t]*["']?([^,"'}\\s]+)`));
  if (inlineMatch) return inlineMatch[1];
  const block = document.match(/^metadata:\s*\r?\n((?:^[ \t]+.*\r?\n?)*)/mu)?.[1] || '';
  return block.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'#\\s]+)`, 'mu'))?.[1] || '';
}

function identity(document) {
  return {
    apiVersion: scalar(document, 'apiVersion'),
    kind: scalar(document, 'kind'),
    namespace: metadataValue(document, 'namespace'),
    name: metadataValue(document, 'name'),
  };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function canonicalAdmissionExpressionSha256(value) {
  return sha256(String(value).replace(/\s+/gu, ' ').trim());
}

export const BOOTSTRAP_INITIALIZER_LIVE_PROFILE = deepFreeze({
  roleRules: [
    { apiGroups: [''], resources: ['secrets', 'configmaps', 'services'], verbs: ['create'] },
    { apiGroups: [''], resources: ['secrets'],
      resourceNames: ['opensphere-platform-release-authority-tls'], verbs: ['get'] },
    { apiGroups: [''], resources: ['configmaps'],
      resourceNames: ['opensphere-platform-release-control-ca'], verbs: ['get'] },
    { apiGroups: [''], resources: ['services'],
      resourceNames: ['opensphere-platform-release-authority'], verbs: ['get'] },
  ],
  roleBinding: {
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: INITIALIZER },
    subjects: [{ kind: 'ServiceAccount', name: INITIALIZER, namespace: NAMESPACE }],
  },
  policies: {
    'platform-release-tls-initializer-custody': {
      resourceRules: [{ apiGroups: [''], apiVersions: ['v1'],
        operations: ['CREATE', 'UPDATE', 'DELETE'], resources: ['secrets', 'configmaps', 'services'] }],
      expressionSha256: 'sha256:44051fcaa74074b698c3b475f0d5b608383df83bb5c88075e501fff66344b614',
      message: 'Platform Release TLS initializer may create only its exact authority resources.',
    },
    'platform-release-tls-initializer-job-boundary': {
      paramKind: { apiVersion: 'apps/v1', kind: 'Deployment' },
      resourceRules: [{ apiGroups: ['batch'], apiVersions: ['v1'],
        operations: ['CREATE', 'UPDATE'], resources: ['jobs'] }],
      expressionSha256: 'sha256:af1c67f58f6e4162a0c1145805b2885375a2b99991c83f0bd04562b8a1709dfb',
      message: 'Platform Release TLS initializer Job is outside its one-shot exact boundary.',
    },
    'platform-release-tls-initializer-pod-boundary': {
      paramKind: { apiVersion: 'apps/v1', kind: 'Deployment' },
      resourceRules: [{ apiGroups: [''], apiVersions: ['v1'],
        operations: ['CREATE'], resources: ['pods'] }],
      expressionSha256: 'sha256:982fe47221c891ffeedf73740e247d56f69d8e44f63badf7c621cb2e76f7076b',
      message: 'Direct Pods cannot use the Platform Release TLS initializer identity.',
    },
    'opensphere-platform-release-authority-service-custody': {
      resourceRules: [{ apiGroups: [''], apiVersions: ['v1'],
        operations: ['CREATE', 'UPDATE', 'DELETE'], resources: ['services'] }],
      expressionSha256: 'sha256:2f4a83b7c69e37f40bdb8e5cbfc09c43fa1bddbad5a08d36657a2d726fe5e935',
      message: 'Platform Release authority Service is exact, internal-only and cannot be deleted.',
    },
    'opensphere-bootstrap-a-initializer-cleanup-journal-custody': {
      resourceRules: [{ apiGroups: [''], apiVersions: ['v1'],
        operations: ['CREATE', 'UPDATE', 'DELETE'], resources: ['configmaps'] }],
      expressionSha256: 'sha256:80d6e0fb592e402067914bc4fc0cf169b500c2c2d19675f46bbc25067a7d9ef7',
      message: 'Bootstrap A cleanup journal is immutable, create-once executor custody.',
    },
  },
  bindings: {
    'platform-release-tls-initializer-custody': {
      policyName: 'platform-release-tls-initializer-custody', validationActions: ['Deny'],
    },
    'platform-release-tls-initializer-job-boundary': {
      policyName: 'platform-release-tls-initializer-job-boundary',
      paramRef: { name: 'opensphere-console-backend', namespace: NAMESPACE,
        parameterNotFoundAction: 'Deny' },
      validationActions: ['Deny'],
    },
    'platform-release-tls-initializer-pod-boundary': {
      policyName: 'platform-release-tls-initializer-pod-boundary',
      paramRef: { name: 'opensphere-console-backend', namespace: NAMESPACE,
        parameterNotFoundAction: 'Deny' },
      validationActions: ['Deny'],
    },
    'opensphere-platform-release-authority-service-custody': {
      policyName: 'opensphere-platform-release-authority-service-custody', validationActions: ['Deny'],
    },
    'opensphere-bootstrap-a-initializer-cleanup-journal-custody': {
      policyName: 'opensphere-bootstrap-a-initializer-cleanup-journal-custody',
      validationActions: ['Deny'],
    },
  },
  networkPolicySpec: {
    podSelector: { matchLabels: { app: INITIALIZER } },
    policyTypes: ['Ingress', 'Egress'],
    ingress: [],
    egress: [
      { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
      ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
      { to: [{ ipBlock: { cidr: '10.96.0.1/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ],
  },
});

function normalizedDocument(document, expected, { sourceRevision, backendImage }) {
  let normalized = String(document).replaceAll('\r\n', '\n').trim();
  if (expected.profile !== 'job') return normalized;
  if (normalized.includes('__SOURCE_REVISION__') || normalized.includes('__BACKEND_IMAGE__')) {
    throw new Error('Bootstrap initializer manifest contains a reserved normalization token');
  }
  const revisionParts = normalized.split(sourceRevision);
  const imageParts = normalized.split(backendImage);
  if (revisionParts.length !== 4 || imageParts.length !== 2) {
    throw new Error('Bootstrap initializer Job dynamic binding count drifted');
  }
  normalized = revisionParts.join('__SOURCE_REVISION__');
  normalized = normalized.split(backendImage).join('__BACKEND_IMAGE__');
  return normalized;
}

function expectedSet(sourceRevision) {
  return [
    ['batch/v1', 'Job', NAMESPACE, `opensphere-tls-init-${sourceRevision}`, 'job',
      'sha256:1f14a367fd23b0ead8bcd09ff2c3fdbff93ef820a212483faced2ea9930007eb'],
    ['v1', 'ServiceAccount', NAMESPACE, INITIALIZER, 'service-account',
      'sha256:9c77405e2f9e235988105af8947447498459ce37518521a468fa98efb411f9ab'],
    ['rbac.authorization.k8s.io/v1', 'Role', NAMESPACE, INITIALIZER, 'role',
      'sha256:2687099cbb9eb3bc63c369d2d484dd221154e08b5fe17d68d741c1be2c52cb22'],
    ['rbac.authorization.k8s.io/v1', 'RoleBinding', NAMESPACE, INITIALIZER, 'role-binding',
      'sha256:bb4b8437ad83a204c060fb2762fe98a301251310b84481371d0a8c7aec4b5be2'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-custody', 'custody-policy',
      'sha256:90d00975af6f1e20c13e1f06150c05da121e33e2eefebe06c54646994b7fe87d'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-custody', 'custody-binding',
      'sha256:62a37cbd44a9e7f8cc5794667a8c10ae80f2588f2f7e66a9dffebc466b4f840a'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-job-boundary', 'job-policy',
      'sha256:454da130cfb5dd5510ca4fbd9d683ec75debbadc8cd547b14eccf8a839669273'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-job-boundary', 'job-binding',
      'sha256:22fbd4a8f8a717b9ca64cd2a3ffaa1b3796be402d03b3503c5af8ca78822c332'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-pod-boundary', 'pod-policy',
      'sha256:916bf3fa32b38fe675e8be32f126381888e67f7bb149513dd6b032e683c40e9c'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-pod-boundary', 'pod-binding',
      'sha256:ec5930efb9e13d61c765f7a0e620e77c5551524d15ab36b62e27b1facea04e32'],
    ['networking.k8s.io/v1', 'NetworkPolicy', NAMESPACE, INITIALIZER, 'network-policy',
      'sha256:b15b9778f2e86bf85d2746eb7ce21515305e156beda7d7533dc3029d26072125'],
  ].map(([apiVersion, kind, namespace, name, profile, documentSha256]) => ({
    apiVersion, kind, namespace, name, profile, documentSha256,
    key: [apiVersion, kind, namespace, name].join('|'),
  }));
}

function validateInitializerDocument(document, expected, { sourceRevision, backendImage }) {
  const actual = sha256(normalizedDocument(document, expected, { sourceRevision, backendImage }));
  if (actual !== expected.documentSha256) {
    throw new Error(`Bootstrap initializer manifest canonical digest drifted: ${expected.kind}/${expected.name}`);
  }
}

const PERMANENT = [
  ['v1', 'Service', NAMESPACE, 'opensphere-platform-release-authority',
    'sha256:86f37258518aff1111996870a544db99ee5babfe3c8d9e503caf6ac4cd26ffbf'],
  ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
    'opensphere-platform-release-authority-service-custody',
    'sha256:b42b790c27165980f0bdbd1ae60b1af4862c9f0a42cbd7724c8d69a0f1c3404e'],
  ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
    'opensphere-platform-release-authority-service-custody',
    'sha256:d9e174df7513e1a8cbfa82436ba2993bc9e5942630756deb7a6db53d5112ea42'],
  ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
    'opensphere-bootstrap-a-initializer-cleanup-journal-custody',
    'sha256:488d03f8843c04396ed3c0565a5baf0800ca979833c22a500958decf11a5dbab'],
  ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
    'opensphere-bootstrap-a-initializer-cleanup-journal-custody',
    'sha256:1fd39c366d72197aace9f96fe0dc8df904b2bc68b7de636e49e9f5b9fb63574e'],
].map(([apiVersion, kind, namespace, name, documentSha256]) => ({
  apiVersion, kind, namespace, name, documentSha256,
  key: [apiVersion, kind, namespace, name].join('|'),
}));

function validatePermanentDocuments(index) {
  for (const expected of PERMANENT) {
    const matches = index.get(expected.key) || [];
    if (matches.length !== 1) {
      throw new Error(`Bootstrap permanent authority manifest count is not one: ${expected.kind}/${expected.name}`);
    }
    const actual = sha256(matches[0].document.replaceAll('\r\n', '\n').trim());
    if (actual !== expected.documentSha256) {
      throw new Error(`Bootstrap permanent authority manifest canonical digest drifted: ${expected.kind}/${expected.name}`);
    }
  }
}

export function projectBootstrapInitializerManifest({
  yaml,
  sourceRevision,
  backendImage,
  bootstrapFrom,
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '')
      || !/^ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}$/
        .test(backendImage ?? '')) {
    throw new Error('Bootstrap initializer projection target binding is invalid');
  }
  if (bootstrapFrom !== undefined && (bootstrapFrom?.contract !== 'opensphere-backend-component-bootstrap/v1'
      || !/^[a-f0-9]{40}$/.test(bootstrapFrom?.sourceRevision ?? ''))) {
    throw new Error('Bootstrap initializer projection bootstrapFrom binding is invalid');
  }
  const sourceDocuments = documents(yaml);
  const entries = sourceDocuments.map((document, position) => ({ document, position, ...identity(document) }));
  const index = new Map();
  for (const entry of entries) {
    const key = [entry.apiVersion, entry.kind, entry.namespace, entry.name].join('|');
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  }
  const expected = expectedSet(sourceRevision);
  const expectedKeys = new Set(expected.map((entry) => entry.key));
  for (const entry of entries) {
    const marked = entry.name.startsWith('opensphere-tls-init-')
      || entry.name.startsWith(INITIALIZER)
      || /(?:^|[,{]\s*)app:\s*platform-release-tls-initializer(?:\s*[,}]|\s*$)/mu.test(entry.document);
    const key = [entry.apiVersion, entry.kind, entry.namespace, entry.name].join('|');
    if (marked && !expectedKeys.has(key)) {
      throw new Error(`Unexpected Bootstrap initializer manifest residue: ${entry.kind}/${entry.name}`);
    }
  }
  for (const item of expected) {
    const matches = index.get(item.key) || [];
    if (matches.length !== 1) {
      throw new Error(`Bootstrap initializer manifest count is not one: ${item.kind}/${item.name}`);
    }
    validateInitializerDocument(matches[0].document, item, { sourceRevision, backendImage });
  }
  validatePermanentDocuments(index);
  const remove = bootstrapFrom === undefined ? new Set() : expectedKeys;
  const projected = entries.filter((entry) => !remove.has(
    [entry.apiVersion, entry.kind, entry.namespace, entry.name].join('|')));
  return {
    contract: BOOTSTRAP_MANIFEST_PROJECTION_CONTRACT,
    mode: bootstrapFrom === undefined ? 'BootstrapAValidatedRetained' : 'BootstrapBValidatedRemoved',
    sourceRevision,
    initializerDocumentCount: 11,
    removedDocumentCount: remove.size,
    retainedPermanentDocumentCount: PERMANENT.length,
    yaml: `${projected.map((entry) => entry.document).join('\n---\n')}\n`,
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const sourceRevision = option('--source-revision');
  const backendImage = option('--backend-image');
  const encoded = option('--bootstrap-from-base64');
  const bootstrapFrom = encoded === undefined
    ? undefined
    : JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const yaml = await readFile(0, 'utf8');
  process.stdout.write(projectBootstrapInitializerManifest({
    yaml, sourceRevision, backendImage, bootstrapFrom,
  }).yaml);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
