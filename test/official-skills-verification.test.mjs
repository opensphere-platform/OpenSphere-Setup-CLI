import test from 'node:test';
import assert from 'node:assert/strict';
import { officialSkillsEvidence, verifyOfficialSkills } from '../src/official-skills-verification.mjs';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const inventory = [{ skillId: 'module-installation', revision: 1 }, { skillId: 'module-product-lifecycle', revision: 1 }, { skillId: 'personal-memory', revision: 2 }];
const skills = (extra = {}) => ({ manifestSha256: DIGEST, shipped: 3, valid: 3, skills: inventory, invalid: [], ...extra });
const ready = (officialSkills) => ({ service: 'opensphere-console-osaa-gateway', ready: true, components: {}, ...(officialSkills === undefined ? {} : { officialSkills }) });

test('a release that declares its Skill manifest requires that exact manifest with every Skill loaded', () => {
  assert.deepEqual(officialSkillsEvidence(ready(skills()), { expected: DIGEST }),
    { state: 'Verified', declared: true, manifestSha256: DIGEST, shipped: 3, valid: 3, skills: inventory });
  assert.throws(() => officialSkillsEvidence(ready(), { expected: DIGEST }), /declares official Skills but the installed Gateway reports none/);
  assert.throws(() => officialSkillsEvidence(ready(skills({ manifestSha256: 'sha256:' + 'b'.repeat(64) })), { expected: DIGEST }), /differs from the release/);
  // One loaded Skill out of one is not the declared inventory: the manifest digest decides.
  assert.throws(() => officialSkillsEvidence(ready(skills({ manifestSha256: 'sha256:' + 'c'.repeat(64), shipped: 1, valid: 1, skills: [inventory[0]] })), { expected: DIGEST }), /differs from the release/);
  assert.throws(() => officialSkillsEvidence(ready(skills({ valid: 2, invalid: [{ skillId: 'personal-memory', reason: 'content-mismatch' }] })), { expected: DIGEST }),
    /2\/3 valid; personal-memory: content-mismatch/);
  assert.throws(() => officialSkillsEvidence(ready(skills()), { expected: 'sha256:short' }), /lock official Skill digest is invalid/);
});

test('only a release that declares no Skills may have none; one that ships them anyway must load them all', () => {
  assert.deepEqual(officialSkillsEvidence(ready()), { state: 'NotShipped', declared: false });
  assert.equal(officialSkillsEvidence(ready(skills())).state, 'Verified');
  assert.equal(officialSkillsEvidence(ready(skills())).declared, false);
  assert.throws(() => officialSkillsEvidence(ready(skills({ valid: 2, invalid: [{ skillId: 'x', reason: 'unreadable' }] }))), /did not load/);
});

test('a malformed or partial report fails instead of passing', () => {
  for (const bad of [{ shipped: 3, valid: 3 }, skills({ manifestSha256: undefined }), skills({ skills: inventory.slice(1) }), skills({ error: 'manifest-unavailable' }),
    skills({ shipped: 0, valid: 0, skills: [] })]) {
    assert.throws(() => officialSkillsEvidence(ready(bad), { expected: DIGEST }), JSON.stringify(bad));
  }
  assert.throws(() => officialSkillsEvidence({ service: 'something-else', officialSkills: skills() }, { expected: DIGEST }), /not the Gateway readiness contract/);
});

test('the report is read from the in-cluster Gateway Service, even while it answers 503', async () => {
  const opened = [];
  const withService = async (namespace, service, port, operation) => { opened.push([namespace, service, port]); return operation('http://127.0.0.1:1'); };
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:1/readyz'); assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ ...ready(skills()), ready: false }), { status: 503 });
  };
  assert.equal((await verifyOfficialSkills({ withService, expected: DIGEST, fetchImpl })).state, 'Verified');
  assert.deepEqual(opened, [['opensphere-console', 'opensphere-console-osaa-gateway', 8080]]);
  const huge = async () => new Response('x'.repeat(70 * 1024));
  await assert.rejects(verifyOfficialSkills({ withService, expected: DIGEST, fetchImpl: huge }), /exceeds its budget/);
  const html = async () => new Response('<html>', { status: 502 });
  await assert.rejects(verifyOfficialSkills({ withService, expected: DIGEST, fetchImpl: html }), /HTTP 502 without JSON/);
});
