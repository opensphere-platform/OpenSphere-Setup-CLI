import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateLock, validateReleaseTransition, calculateReleaseDigest } from '../src/release.mjs';
import { componentReleaseWorkloadComponents, componentReleaseManifestSpecs, componentReleaseWorkloadManifests,
  OS_SHELL_MANIFEST, renderManifest, COMPONENT_ROLLOUTS } from '../src/bootstrap.mjs';
import { verifyShellRuntimeReferences } from '../src/verify.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json', import.meta.url)));
function transition(names = ['cliArtifacts', 'osShellControl', 'osShellRuntime']) {
  const base = structuredClone(fixture.base), target = structuredClone(base);
  target.sourceRevision = 'b'.repeat(40); target.releaseScope = 'component'; target.baseReleaseDigest = base.releaseDigest;
  target.changedComponents = ['osdst']; target.changedAuxiliaryArtifacts = names;
  for (const [kind, keys] of [['components', target.changedComponents], ['auxiliaryArtifacts', names]]) {
    for (const name of keys) { target[kind][name].sourceRevision = target.sourceRevision;
      target[kind][name].image = `ghcr.io/opensphere-platform/${target[kind][name].repository}@sha256:${'b'.repeat(64)}`; }
  }
  target.releaseDigest = calculateReleaseDigest(target.channel, target.components, target.trust, undefined, target);
  return { base, target };
}

test('native component release selects Shell, CLI and OSDST without touching Backbone', () => {
  const {base,target} = transition(); const before = JSON.stringify(base);
  validateLock(target); validateReleaseTransition(base,target);
  assert.deepEqual(componentReleaseWorkloadComponents(target), ['cliArtifacts','osShellControl','osdst']);
  const specs = componentReleaseManifestSpecs(target);
  assert.deepEqual(specs.foundation, []);
  assert.deepEqual(specs.base.map(s=>s.path).sort(), ['apps/os-shell-control/deploy.yaml','apps/osdst/deploy.yaml','cmd/os-cli/deploy.yaml']);
  assert.ok(specs.base.every(s=>s.artifactSourceRevision===target.sourceRevision));
  const rollback = componentReleaseManifestSpecs(base,componentReleaseWorkloadComponents(target));
  assert.ok(rollback.base.every(s=>s.artifactSourceRevision===base.sourceRevision));
  assert.equal(JSON.stringify(base),before);
  assert.equal(COMPONENT_ROLLOUTS.osShellControl.length,3);
  assert.equal(COMPONENT_ROLLOUTS.cliArtifacts[0][1],'deployment/os-cli');
});

test('partial, unlisted and wrong-source Shell artifacts cannot be admitted', () => {
  for(const names of [['osShellControl'],['osShellRuntime'],['cliArtifacts','osShellControl'],['osShellRuntime','osShellControl','cliArtifacts']]) {
    assert.throws(()=>validateLock(transition(names).target));
  }
  const {base,target}=transition(); target.auxiliaryArtifacts.osShellRuntime.sourceRevision='c'.repeat(40);
  target.releaseDigest=calculateReleaseDigest(target.channel,target.components,target.trust,undefined,target);
  assert.throws(()=>validateReleaseTransition(base,target),/source revision/);
});

test('source-rendered Shell keeps the runtime, CLI digest and exact template evidence together', () => {
  const {target}=transition();
  const source = ['apiVersion: apps/v1','kind: Deployment','metadata: {name: opensphere-shell-api}',
    'spec:', '  template:', '    spec:', '      containers:', '        - name: api',
    '          image: __OPENSPHERE_OS_SHELL_CONTROL_IMAGE__','          env:',
    '            - {name: OS_SHELL_RUNTIME_IMAGE, value: "__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__"}',
    '            - {name: OS_SHELL_OS_ARTIFACT_DIGEST, value: "__OPENSPHERE_OS_SHELL_OS_ARTIFACT_DIGEST__"}',
    '            - {name: MANIFEST, value: "__OPENSPHERE_OS_SHELL_MANIFEST_SHA256__"}',
    '            - {name: TEMPLATE, value: "__OPENSPHERE_OS_SHELL_RUNTIME_TEMPLATE_SHA256__"}',
    '            - {name: EVIDENCE, value: "__OPENSPHERE_OS_SHELL_RELEASE_EVIDENCE_REF__"}',
    '---','apiVersion: admissionregistration.k8s.io/v1','kind: ValidatingAdmissionPolicy',
    'metadata: {name: opensphere-shell-runtime-image}',
    'spec: {validations: [{expression: "object.spec.containers.all(c, c.image == \'__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__\')"}]}'].join('\n');
  const template='module.exports = Object.freeze({fixture:true});\n';
  assert.throws(()=>renderManifest(target,OS_SHELL_MANIFEST,source,'standard','https://localhost:1114','development'),/exact source runtime template/);
  const rendered=renderManifest(target,OS_SHELL_MANIFEST,source,'standard','https://localhost:1114','development',{runtimeTemplateSource:template});
  assert.ok(rendered.includes(target.auxiliaryArtifacts.osShellRuntime.image));
  assert.ok(rendered.includes('sha256:'+createHash('sha256').update(template).digest('hex')));
  assert.ok(rendered.includes('sha256:'+createHash('sha256').update(source).digest('hex')));
  assert.doesNotMatch(rendered,/__OPENSPHERE_/);
  const applied=componentReleaseWorkloadManifests(target,{foundation:{release:[]},base:[{path:OS_SHELL_MANIFEST.path,yaml:rendered}]},['osShellControl']);
  assert.equal(applied.length,1); assert.match(applied[0].yaml,/kind: ValidatingAdmissionPolicy/);
});

test('Ready controller cannot hide an outdated runtime image or CLI digest', () => {
  const {base,target}=transition(); const env=[
    {name:'OS_SHELL_RUNTIME_IMAGE',value:target.auxiliaryArtifacts.osShellRuntime.image},
    {name:'OS_SHELL_OS_ARTIFACT_DIGEST',value:target.auxiliaryArtifacts.cliArtifacts.image.split('@')[1]}];
  assert.equal(verifyShellRuntimeReferences(target,{env}),true);
  assert.throws(()=>verifyShellRuntimeReferences(target,{env:[{...env[0],value:base.auxiliaryArtifacts.osShellRuntime.image},env[1]]}));
  assert.throws(()=>verifyShellRuntimeReferences(target,{env:[env[0]]}));
});
