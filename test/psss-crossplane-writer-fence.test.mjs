import test from 'node:test';
import assert from 'node:assert/strict';
import {POLICY,BINDING,CM_USERNAME,matchesWriterFence} from '../src/psss-crossplane-writer-fence.mjs';

test('Crossplane writer fence is scoped to the CM service account and has no missing parameter',()=>{
 assert.equal(POLICY.spec.matchConditions[0].expression,`request.userInfo.username == '${CM_USERNAME}'`);
 assert.equal(POLICY.spec.failurePolicy,'Fail');
 assert.deepEqual(BINDING.spec.validationActions,['Deny']);
 assert.equal(Object.hasOwn(POLICY.spec,'paramKind'),false);
 assert.equal(Object.hasOwn(BINDING.spec,'paramRef'),false);
 assert.deepEqual(POLICY.spec.matchConstraints.resourceRules[0].operations,['CREATE','UPDATE','DELETE']);
 assert.match(POLICY.spec.validations[0].expression,/request\.namespace != 'crossplane-system'/);
 assert.match(POLICY.spec.validations[0].expression,/request\.resource\.group != 'crossplane.io'/);
 assert.match(POLICY.spec.validations[0].expression,/customresourcedefinitions/);
});
test('only the exact active policy and binding match the reviewed fence',()=>{
 assert.equal(matchesWriterFence(POLICY,BINDING),true);
 assert.equal(matchesWriterFence({...POLICY,spec:{...POLICY.spec,failurePolicy:'Ignore'}},BINDING),false);
 assert.equal(matchesWriterFence(POLICY,{...BINDING,spec:{...BINDING.spec,validationActions:['Audit']}}),false);
 assert.equal(matchesWriterFence({...POLICY,metadata:{...POLICY.metadata,deletionTimestamp:'now'}},BINDING),false);
});
