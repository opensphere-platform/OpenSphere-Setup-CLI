import test from 'node:test';
import assert from 'node:assert/strict';
import {workloadReady} from '../src/verify.mjs';

test('completed bootstrap Job uses terminal success rather than a missing observedGeneration', () => {
  const job={kind:'Job',metadata:{generation:1},spec:{completions:1},status:{succeeded:1,conditions:[{type:'Complete',status:'True'}]}};
  assert.equal(workloadReady(job),true);
  assert.equal(workloadReady({...job,status:{succeeded:1}}),false);
  assert.equal(workloadReady({...job,status:{...job.status,failed:1}}),false);
  assert.equal(workloadReady({...job,status:{...job.status,succeeded:0}}),false);
  assert.equal(workloadReady({...job,status:{...job.status,conditions:[...job.status.conditions,{type:'Failed',status:'True'}]}}),false);
});

test('service workloads still require the current observed generation', () => {
  const deployment={kind:'Deployment',metadata:{generation:2},spec:{replicas:1},status:{observedGeneration:1,readyReplicas:1,updatedReplicas:1,availableReplicas:1}};
  assert.equal(workloadReady(deployment),false);
  assert.equal(workloadReady({...deployment,status:{...deployment.status,observedGeneration:2}}),true);
});