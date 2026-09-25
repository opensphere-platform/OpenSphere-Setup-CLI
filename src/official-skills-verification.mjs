// Decision 19 (R2D2 plan): the official Console Skills ship inside the signed Gateway image.
// Review R2 (2026-09-25): whether Skills are required comes from the verified release, not from
// the answer. The Gateway image declares its Skill manifest digest in the label
// io.opensphere.official-skills; release resolution records it in the lock
// (components.osaaGateway.officialSkills). After an installation, update or rollback the Gateway
// running the locked image must report on /readyz that same manifest with every Skill loaded.
// A release that declares no Skills is recorded as NotShipped only when its Gateway reports none.
// This is the Skill files' load state only: not Gateway readiness and not R2D2 acceptance.
const MAX_BODY = 64 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function report(skills) {
  if (!skills || typeof skills !== 'object' || !Number.isSafeInteger(skills.shipped) || !Number.isSafeInteger(skills.valid)
      || !Array.isArray(skills.invalid) || skills.invalid.length > 64) {
    throw new Error('Gateway official Skill report is malformed');
  }
  if (skills.error) throw new Error('Gateway image ships no readable official Skill manifest');
  if (!DIGEST.test(skills.manifestSha256 ?? '') || !Array.isArray(skills.skills) || skills.skills.length !== skills.shipped
      || skills.skills.some((s) => !SKILL_ID.test(s?.skillId ?? '') || !(s.revision === null || Number.isSafeInteger(s.revision)))) {
    throw new Error('Gateway official Skill report has no manifest digest or inventory');
  }
  if (skills.shipped < 1) throw new Error('Gateway image reports official Skills but ships none');
  if (skills.valid !== skills.shipped || skills.invalid.length) {
    const why = skills.invalid.slice(0, 8)
      .map((s) => `${String(s?.skillId ?? '?').slice(0, 64)}: ${String(s?.reason ?? 'invalid').slice(0, 32)}`).join(', ');
    throw new Error(`Official Skills in the Gateway image did not load (${skills.valid}/${skills.shipped} valid${why ? `; ${why}` : ''})`);
  }
  return {
    manifestSha256: skills.manifestSha256, shipped: skills.shipped, valid: skills.valid,
    skills: skills.skills.map((s) => ({ skillId: s.skillId, revision: s.revision }))
  };
}

// expected: the manifest digest the locked Gateway image declared, or undefined when it declared none.
export function officialSkillsEvidence(readiness, { expected } = {}) {
  if (!readiness || typeof readiness !== 'object' || readiness.service !== 'opensphere-console-osaa-gateway') {
    throw new Error('Gateway readiness response is not the Gateway readiness contract');
  }
  if (expected !== undefined && !DIGEST.test(expected)) throw new Error('Release lock official Skill digest is invalid');
  const reported = Object.hasOwn(readiness, 'officialSkills');
  if (expected === undefined) {
    if (!reported) return { state: 'NotShipped', declared: false };
    // Not declared by the release, yet shipped: still every file must load.
    return { state: 'Verified', declared: false, ...report(readiness.officialSkills) };
  }
  if (!reported) throw new Error('The release declares official Skills but the installed Gateway reports none');
  const verified = report(readiness.officialSkills);
  if (verified.manifestSha256 !== expected) {
    throw new Error(`Installed Gateway Skill manifest ${verified.manifestSha256} differs from the release (${expected})`);
  }
  return { state: 'Verified', declared: true, ...verified };
}

// withService(namespace, service, port, operation) opens a local tunnel to the in-cluster
// Service; /readyz is in-cluster only. A 503 body still carries the Skill report.
export async function verifyOfficialSkills({ withService, expected, fetchImpl = fetch }) {
  return withService('opensphere-console', 'opensphere-console-osaa-gateway', 8080, async (base) => {
    const response = await fetchImpl(`${base}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BODY) throw new Error('Gateway readiness response exceeds its budget');
    let readiness;
    try { readiness = JSON.parse(text); } catch { throw new Error(`Gateway readiness returned HTTP ${response.status} without JSON`); }
    return officialSkillsEvidence(readiness, { expected });
  });
}
