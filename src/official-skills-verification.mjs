// Decision 19 (R2D2 plan): the official Console Skills ship inside the signed Gateway image.
// After an installation, update or rollback, the Gateway running the locked image reports on
// /readyz which of its shipped Skills loaded (counts and reasons, never the text). A Gateway
// built before decision 19 reports nothing, which is recorded as such and not as a failure.
const MAX_BODY = 64 * 1024;

export function officialSkillsEvidence(readiness) {
  if (!readiness || typeof readiness !== 'object' || readiness.service !== 'opensphere-console-osaa-gateway') {
    throw new Error('Gateway readiness response is not the Gateway readiness contract');
  }
  if (!Object.hasOwn(readiness, 'officialSkills')) return { state: 'NotShipped' };
  const skills = readiness.officialSkills;
  if (!skills || typeof skills !== 'object' || !Number.isSafeInteger(skills.shipped) || !Number.isSafeInteger(skills.valid)
      || !Array.isArray(skills.invalid) || skills.invalid.length > 64) {
    throw new Error('Gateway official Skill report is malformed');
  }
  if (skills.error) throw new Error('Gateway image ships no readable official Skill manifest');
  if (skills.shipped < 1) throw new Error('Gateway image reports official Skills but ships none');
  if (skills.valid !== skills.shipped || skills.invalid.length) {
    const why = skills.invalid.slice(0, 8)
      .map((s) => `${String(s?.skillId ?? '?').slice(0, 64)}: ${String(s?.reason ?? 'invalid').slice(0, 32)}`).join(', ');
    throw new Error(`Official Skills in the Gateway image did not load (${skills.valid}/${skills.shipped} valid${why ? `; ${why}` : ''})`);
  }
  return { state: 'Verified', shipped: skills.shipped, valid: skills.valid };
}

// withService(namespace, service, port, operation) opens a local tunnel to the in-cluster
// Service; /readyz is in-cluster only. A 503 body still carries the Skill report.
export async function verifyOfficialSkills({ withService, fetchImpl = fetch }) {
  return withService('opensphere-console', 'opensphere-console-osaa-gateway', 8080, async (base) => {
    const response = await fetchImpl(`${base}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BODY) throw new Error('Gateway readiness response exceeds its budget');
    let readiness;
    try { readiness = JSON.parse(text); } catch { throw new Error(`Gateway readiness returned HTTP ${response.status} without JSON`); }
    return officialSkillsEvidence(readiness);
  });
}
