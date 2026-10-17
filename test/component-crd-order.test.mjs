// RKE2 2026-10-17: a component upgrade applied the extension controller manifest (with its ValidatingAdmissionPolicies)
// before the CRD that gained spec.moduleRelease. The policy kept a stale "undefined field" type-checking warning and
// C_EXT refused Provider delivery. CRD manifests are now applied, and Established, before the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitComponentReleaseCrds, customResourceDefinitionNames } from '../src/bootstrap.mjs';

const crd = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: uipluginpackages.plugins.opensphere.io
  labels:
    app.kubernetes.io/part-of: opensphere-console
spec: {}
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  labels:
    app.kubernetes.io/part-of: opensphere-console
  name: "uipluginregistrations.plugins.opensphere.io"
spec: {}
`;
const controller = `apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: opensphere-pfss-registration-writer
spec: {}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opensphere-extension-controller
spec: {}
`;

test('CRD manifests are applied before the manifests that hold policies, in their original order', () => {
  const release = [
    { path: 'apps/extension-controller/deploy.yaml#extensionController', yaml: controller },
    { path: 'apps/extension-controller/crds/ui-plugin-crds.yaml#extensionController', yaml: crd },
  ];
  const { crds, rest } = splitComponentReleaseCrds(release);
  assert.deepEqual(crds.map(m => m.path), ['apps/extension-controller/crds/ui-plugin-crds.yaml#extensionController']);
  assert.deepEqual(rest.map(m => m.path), ['apps/extension-controller/deploy.yaml#extensionController']);
  assert.deepEqual(customResourceDefinitionNames(crd), ['uipluginpackages.plugins.opensphere.io', 'uipluginregistrations.plugins.opensphere.io']);
});

test('a manifest that mixes a CRD with other kinds is not a CRD manifest', () => {
  const mixed = crd + '---\n' + controller;
  const { crds, rest } = splitComponentReleaseCrds([{ path: 'mixed#x', yaml: mixed }]);
  assert.equal(crds.length, 0); assert.equal(rest.length, 1);
  assert.deepEqual(customResourceDefinitionNames(controller), []);
});
