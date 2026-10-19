import test from 'node:test';
import assert from 'node:assert/strict';
import bindingCrd from '../src/hiss-observability-binding-crd-artifact.json' with {type:'json'};
import {observabilityBindingCrdRules, prepareHissObservabilityBindingCrd, verifyHissObservabilityBindingCrd} from '../src/hiss-prerequisites.mjs';

// Y2 (PFSS Provider runtime ownership design r2, 2026-10-19): the CRD from Cluster Manager 93180e6 admits targets in
// opensphere-foundation only. An installed CRD without the rule is an older revision the plan names, and the apply
// updates it in place (server-side apply).
const scope = {context:'rke2', channel:'edge', consoleUrl:'https://console.opensphere.triangles.com'};
const served = (rules) => JSON.stringify({spec:{versions:[{name:'v1alpha2', schema:{openAPIV3Schema:{properties:{spec:{properties:{targets:{
  ...(rules ? {'x-kubernetes-validations': rules.map((rule) => ({rule}))} : {})}}}}}}}]}});

test('the approved CRD carries the target namespace rules', () => {
  verifyHissObservabilityBindingCrd(bindingCrd.yaml);
  assert.deepEqual(observabilityBindingCrdRules(bindingCrd.yaml), [
    "!has(self.workloads) || self.workloads.all(t, t.__namespace__ == 'opensphere-foundation')",
    "!has(self.persistentVolumeClaims) || self.persistentVolumeClaims.all(t, t.__namespace__ == 'opensphere-foundation')",
  ]);
  assert.throws(() => verifyHissObservabilityBindingCrd(bindingCrd.yaml.replace(/opensphere-foundation'\)"/, "kube-system')\"")), /differ/);
});

test('the plan tells a missing, an older and the current CRD apart; the apply is a server-side apply', () => {
  const plan = (live) => prepareHissObservabilityBindingCrd(bindingCrd.yaml, scope, {runner: (_exe, args) => {
    assert.ok(args.includes('get') && args.includes('json'));
    return live;
  }});
  assert.equal(plan('').state, 'NeedsPreparation');
  assert.equal(plan(served(null)).state, 'NeedsUpdate');
  assert.equal(plan(served(observabilityBindingCrdRules(bindingCrd.yaml).slice(0, 1))).state, 'NeedsUpdate');
  assert.equal(plan(served(observabilityBindingCrdRules(bindingCrd.yaml))).state, 'Present');
  assert.equal(plan('not json').state, 'NeedsUpdate');
  const applies = [];
  const applied = prepareHissObservabilityBindingCrd(bindingCrd.yaml, scope, {apply: true, runner: (_exe, args, options) => {
    applies.push([args, options.input]);
    return '';
  }});
  assert.equal(applied.state, 'Applied');
  assert.ok(applies[0][0].includes('--server-side') && applies[0][0].includes('--field-manager=opensphere-setup-hiss'));
  assert.equal(applies[0][1], bindingCrd.yaml);
});
