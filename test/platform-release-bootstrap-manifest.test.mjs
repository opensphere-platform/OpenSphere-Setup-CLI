import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { componentReleaseWorkloadManifests } from '../src/bootstrap.mjs';
import { projectBootstrapInitializerManifest } from '../src/platform-release-bootstrap-manifest.mjs';

const AUTHORITY_FIXTURE = new URL(
  './fixtures/platform-release-bootstrap-a-authority.yaml', import.meta.url
);
const revision = 'a'.repeat(40);
const image = `ghcr.io/opensphere-platform/opensphere-console-backend@sha256:${'b'.repeat(64)}`;
const bootstrapFrom = {
  contract: 'opensphere-backend-component-bootstrap/v1',
  sourceRevision: '9'.repeat(40),
};

function documents(yaml) {
  return String(yaml).split(/^---\s*$/mu).map((entry) => entry.trim()).filter(Boolean);
}

function scalar(document, key) {
  return document.match(new RegExp(`^${key}:[ \\t]*["']?([^"'#{\\s]+)`, 'mu'))?.[1] || '';
}

function metadataValue(document, key) {
  const inline = document.match(/^metadata:\s*\{([^\n]+)\}\s*$/mu)?.[1] || '';
  const inlineMatch = inline.match(new RegExp(`(?:^|,)[ \\t]*${key}:[ \\t]*["']?([^,"'}\\s]+)`));
  if (inlineMatch) return inlineMatch[1];
  const block = document.match(/^metadata:\s*\r?\n((?:^[ \t]+.*\r?\n?)*)/mu)?.[1] || '';
  return block.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'#\\s]+)`, 'mu'))?.[1] || '';
}

function fixture() {
  let source = readFileSync(AUTHORITY_FIXTURE, 'utf8').replaceAll('\r\n', '\n');
  assert.equal(documents(source).length, 16,
    'committed Bootstrap A authority fixture must contain exactly 16 documents');
  const images = new Set(source.match(
    /ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}/gu
  ) || []);
  assert.equal(images.size, 1, 'canonical Backend manifest must contain one exact Backend image');
  source = source.replaceAll([...images][0], image);
  source = source.replaceAll('__OPENSPHERE_RELEASE_REVISION__', revision);
  return source;
}

function componentFixture() {
  return `${fixture()}---
apiVersion: apps/v1
kind: Deployment
metadata: { name: opensphere-console-backend, namespace: opensphere-console }
spec:
  template:
    spec:
      containers:
        - name: backend
          image: ${image}
`;
}

function mutateDocument(yaml, kind, name, mutate) {
  const source = documents(yaml);
  const matches = source.map((document, index) => ({ document, index })).filter(({ document }) =>
    scalar(document, 'kind') === kind && metadataValue(document, 'name') === name);
  assert.equal(matches.length, 1, `fixture must contain exact ${kind}/${name}`);
  source[matches[0].index] = mutate(matches[0].document);
  assert.notEqual(source[matches[0].index], matches[0].document,
    `mutation must change ${kind}/${name}`);
  return `${source.join('\n---\n')}\n`;
}

function project(yaml, bootstrap) {
  return projectBootstrapInitializerManifest({
    yaml, sourceRevision: revision, backendImage: image,
    bootstrapFrom: arguments.length < 2 ? bootstrapFrom : bootstrap,
  });
}

test('Bootstrap A validates committed canonical digests and retains exact initializer authority', () => {
  const result = project(fixture(), undefined);
  assert.equal(result.mode, 'BootstrapAValidatedRetained');
  assert.equal(result.initializerDocumentCount, 11);
  assert.equal(result.removedDocumentCount, 0);
  assert.match(result.yaml, new RegExp(`opensphere-tls-init-${revision}`));
  assert.match(result.yaml, /platform-release-tls-initializer-job-boundary/);
});

test('Bootstrap B removes canonical initializer authority and retains exact permanent custody', () => {
  const result = project(fixture());
  assert.equal(result.mode, 'BootstrapBValidatedRemoved');
  assert.equal(result.removedDocumentCount, 11);
  assert.equal(result.retainedPermanentDocumentCount, 5);
  assert.doesNotMatch(result.yaml, /name: platform-release-tls-initializer(?:\s|$)/);
  assert.doesNotMatch(result.yaml, /opensphere-tls-init-/);
  assert.match(result.yaml, /opensphere-platform-release-authority-service-custody/);
  assert.match(result.yaml, /opensphere-bootstrap-a-initializer-cleanup-journal-custody/);
  assert.equal(project(fixture()).yaml, result.yaml);
});

test('component application uses the same committed Bootstrap B projection', () => {
  const lock = {
    sourceRevision: revision,
    changedComponents: ['backend'],
    components: { backend: { image, sourceRevision: revision } },
    componentPublication: { bootstrapFrom },
  };
  const selected = componentReleaseWorkloadManifests(lock, {
    foundation: { release: [] },
    base: [{ path: 'backend/opensphere-console-backend/deploy.yaml', yaml: componentFixture() }],
  });
  assert.equal(selected.length, 1);
  assert.doesNotMatch(selected[0].yaml, /name: platform-release-tls-initializer(?:\s|$)/);
  assert.doesNotMatch(selected[0].yaml, /opensphere-tls-init-/);
  assert.match(selected[0].yaml, /opensphere-platform-release-authority-service-custody/);
  assert.match(selected[0].yaml, new RegExp(image.replaceAll('.', '\\.')));
});

test('canonical digest rejects missing, duplicate, and unexpected initializer documents', () => {
  const source = fixture();
  const serviceAccount = documents(source).find((document) =>
    /^kind: ServiceAccount$/mu.test(document)
      && /name: platform-release-tls-initializer/mu.test(document));
  const cases = [
    source.replace(`${serviceAccount}\n---\n`, ''),
    `${source}\n---\n${serviceAccount}\n`,
    `${source}\n---\napiVersion: batch/v1\nkind: Job\nmetadata: { name: opensphere-tls-init-${'c'.repeat(40)}, namespace: opensphere-console }\n`,
  ];
  for (const yaml of cases) {
    assert.throws(() => project(yaml), /Bootstrap initializer|Unexpected Bootstrap initializer/);
  }
});

test('canonical digest rejects every privileged initializer authority broadening', () => {
  const source = fixture();
  const cases = [
    mutateDocument(source, 'Role', 'platform-release-tls-initializer', (document) =>
      document.replace('verbs: ["create"]', 'verbs: ["create", "get"]')),
    mutateDocument(source, 'Role', 'platform-release-tls-initializer', (document) =>
      `${document}\n  - apiGroups: ["*"]\n    resources: ["*"]\n    verbs: ["*"]`),
    mutateDocument(source, 'ValidatingAdmissionPolicy',
      'platform-release-tls-initializer-job-boundary', (document) =>
        document.replace('resources: ["jobs"]', 'resources: ["jobs", "cronjobs"]')),
    mutateDocument(source, 'ValidatingAdmissionPolicy',
      'platform-release-tls-initializer-pod-boundary', (document) =>
        document.replace('operations: ["CREATE"]', 'operations: ["CREATE", "UPDATE"]')),
    mutateDocument(source, 'ValidatingAdmissionPolicyBinding',
      'platform-release-tls-initializer-job-boundary', (document) =>
        document.replace('validationActions: [Deny]', 'validationActions: [Warn]')),
    mutateDocument(source, 'NetworkPolicy', 'platform-release-tls-initializer', (document) =>
      document.replace('port: 443', 'port: 443\n          - { protocol: TCP, port: 6443 }')),
    mutateDocument(source, 'NetworkPolicy', 'platform-release-tls-initializer', (document) =>
      document.replace('cidr: 10.96.0.1/32', 'cidr: 0.0.0.0/0')),
    mutateDocument(source, 'Job', `opensphere-tls-init-${revision}`, (document) =>
      document.replace('name: PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE',
        'name: EXTRA\n              value: unsafe\n            - name: PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE')),
    mutateDocument(source, 'Job', `opensphere-tls-init-${revision}`, (document) =>
      document.replace('      volumes:', '      volumes:\n        - { name: host, hostPath: { path: / } }')),
    mutateDocument(source, 'Job', `opensphere-tls-init-${revision}`, (document) =>
      document.replace('allowPrivilegeEscalation: false', 'allowPrivilegeEscalation: true')),
    mutateDocument(source, 'Job', `opensphere-tls-init-${revision}`, (document) =>
      document.replace('limits: { cpu: 500m, memory: 256Mi }',
        'limits: { cpu: 2, memory: 2Gi }')),
  ];
  for (const yaml of cases) {
    assert.throws(() => project(yaml), /canonical digest drifted/);
  }
});

test('canonical digest rejects permanent Service and custody mutation', () => {
  const source = fixture();
  const cases = [
    mutateDocument(source, 'Service', 'opensphere-platform-release-authority', (document) =>
      document.replace('spec:', 'spec:\n  type: LoadBalancer')),
    mutateDocument(source, 'ValidatingAdmissionPolicy',
      'opensphere-platform-release-authority-service-custody', (document) =>
        document.replace("request.operation == 'CREATE'", "request.operation == 'CREATE' || true")),
    mutateDocument(source, 'ValidatingAdmissionPolicy',
      'opensphere-bootstrap-a-initializer-cleanup-journal-custody', (document) =>
        document.replace('resources: ["configmaps"]', 'resources: ["configmaps", "secrets"]')),
    mutateDocument(source, 'ValidatingAdmissionPolicyBinding',
      'opensphere-bootstrap-a-initializer-cleanup-journal-custody', (document) =>
        document.replace('validationActions: [Deny]', 'validationActions: [Warn]')),
  ];
  for (const yaml of cases) {
    assert.throws(() => project(yaml), /permanent authority manifest canonical digest drifted/);
  }
});
