import test from 'node:test';
import assert from 'node:assert/strict';
import { officialSkillsEvidence, verifyOfficialSkills } from '../src/official-skills-verification.mjs';

const ready = (officialSkills) => ({ service: 'opensphere-console-osaa-gateway', ready: true, components: {}, ...(officialSkills === undefined ? {} : { officialSkills }) });

test('a Gateway whose shipped Skills all loaded is verified; one built before Skills is recorded as not shipping them', () => {
  assert.deepEqual(officialSkillsEvidence(ready({ shipped: 3, valid: 3, invalid: [] })), { state: 'Verified', shipped: 3, valid: 3 });
  assert.deepEqual(officialSkillsEvidence(ready()), { state: 'NotShipped' });
});

test('an edited, unreadable or missing Skill in the locked image fails the verification', () => {
  assert.throws(() => officialSkillsEvidence(ready({ shipped: 3, valid: 2, invalid: [{ skillId: 'personal-memory', reason: 'content-mismatch' }] })),
    /2\/3 valid; personal-memory: content-mismatch/);
  assert.throws(() => officialSkillsEvidence(ready({ shipped: 0, valid: 0, invalid: [], error: 'manifest-unavailable' })), /no readable official Skill manifest/);
  assert.throws(() => officialSkillsEvidence(ready({ shipped: 0, valid: 0, invalid: [] })), /ships none/);
  assert.throws(() => officialSkillsEvidence(ready({ shipped: 3, valid: 3 })), /malformed/);
  assert.throws(() => officialSkillsEvidence({ service: 'something-else', officialSkills: { shipped: 1, valid: 1, invalid: [] } }), /not the Gateway readiness contract/);
});

test('the report is read from the in-cluster Gateway Service, even while it answers 503', async () => {
  const opened = [];
  const withService = async (namespace, service, port, operation) => { opened.push([namespace, service, port]); return operation('http://127.0.0.1:1'); };
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:1/readyz'); assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ ...ready({ shipped: 3, valid: 3, invalid: [] }), ready: false }), { status: 503 });
  };
  assert.deepEqual(await verifyOfficialSkills({ withService, fetchImpl }), { state: 'Verified', shipped: 3, valid: 3 });
  assert.deepEqual(opened, [['opensphere-console', 'opensphere-console-osaa-gateway', 8080]]);
  const huge = async () => new Response('x'.repeat(70 * 1024));
  await assert.rejects(verifyOfficialSkills({ withService, fetchImpl: huge }), /exceeds its budget/);
  const html = async () => new Response('<html>', { status: 502 });
  await assert.rejects(verifyOfficialSkills({ withService, fetchImpl: html }), /HTTP 502 without JSON/);
});
