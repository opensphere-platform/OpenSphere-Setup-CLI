// Installation pipeline contract: resource creation is not an optional
// post-install patch, and a personal runtime is not part of a fresh Pod set.
import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
const source=readFileSync(new URL('../src/bootstrap.mjs',import.meta.url),'utf8');
const part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)+start.length));
test('fresh native namespace and reviewed quota precede the eight-namespace pull credential handoff',()=>{
 const body=part('export async function bootstrap(','export async function upgrade(');
 const identity=body.indexOf('ensureInstallationIdentity({adoptInstallationId:prepared.foundation.nativeRuntime.installationId})');
 const plan=body.indexOf('applyNativeRuntimePrerequisites(prepared.foundation.nativeRuntime)'),pull=body.indexOf('ensureRegistryPullSecrets(lock,');
 assert(identity>0&&plan>identity&&pull>plan);assert(body.includes('prepared.foundation.nativePrerequisitesApplied=true'));
});
test('integrated and component installers prepare the native namespace and pull Secret before C_API workloads',()=>{
 const full=part('async function installPreparedRelease(','export async function bootstrap(');
 assert(full.indexOf('applyNativeRuntimePrerequisites(')>=0);
 assert(full.indexOf('bootstrapNativeRegistryCredential(')>full.indexOf('applyNativeRuntimePrerequisites('));
 assert(full.indexOf('runFoundationInstallers(')>full.indexOf('bootstrapNativeRegistryCredential('));
 const component=part('function installPreparedComponentRelease(','export function');
 assert(component.indexOf('bootstrapNativeRegistryCredential(')>component.indexOf('applyNativeRuntimePrerequisites('));
 assert(component.indexOf('runComponentMigrations(')>component.indexOf('bootstrapNativeRegistryCredential('));
});
test('the owner API installer is invoked before the native runtime installer after the namespace boundary exists',()=>{
 const installer=part('function runFoundationInstallers(','export function assertComponentMigrationPrefix');
 assert(installer.indexOf('Install-ConsoleApiRuntime.ps1')>=0);
 assert(installer.indexOf('Install-ConsoleNativeRuntime.ps1')>installer.indexOf('Install-ConsoleApiRuntime.ps1'));
});
