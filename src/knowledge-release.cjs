'use strict';
// CON-FR-007/018: Knowledge is release data, not a changed Gateway image.
const { validateLock } = require('./knowledge-package.cjs');
const canonical = value => value && typeof value === 'object'
  ? (Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function knowledgeReleaseFields(lock) {
  return {
    ...(lock.changedKnowledge !== undefined ? { changedKnowledge: lock.changedKnowledge } : {}),
    ...(lock.knowledge !== undefined ? { knowledge: lock.knowledge } : {}),
  };
}

function validateKnowledgeRelease(lock) {
  if (lock.knowledge === undefined && lock.changedKnowledge === undefined) return;
  validateLock(lock.knowledge);
  if (lock.knowledge.version.length > 80) throw Error('Knowledge version exceeds the release budget');
  if (lock.channel !== 'edge' || lock.trust?.type !== 'localhost-edge/v1'
      || !/^knowledge-v\d+\.\d+\.\d+-edge\.\d+$/.test(lock.knowledge.version)) {
    throw Error('Independent Knowledge delivery requires the admitted localhost edge release policy');
  }
  if (lock.changedKnowledge !== undefined && (lock.changedKnowledge !== true || lock.releaseScope !== 'component')) {
    throw Error('changedKnowledge must be true on a component transition');
  }
  if (!lock.components?.consoleApi || !lock.components?.extensionController || !lock.components?.osaaGateway) {
    throw Error('Knowledge delivery requires the current Console component profile');
  }
}

function versionParts(version) {
  const match = /^knowledge-v(\d+)\.(\d+)\.(\d+)-edge\.(\d+)$/.exec(version);
  if (!match) throw Error('Knowledge transition version is invalid');
  return match.slice(1).map(BigInt);
}

function validateKnowledgeTransition(base, target) {
  if ((target.releaseScope || 'integrated') !== 'component') return;
  const differs = !same(base.knowledge, target.knowledge);
  if (differs !== (target.changedKnowledge === true)) {
    throw Error('Knowledge change does not match the declared transition');
  }
  if (!differs) return;
  if (!target.knowledge) throw Error('A component transition cannot remove Knowledge');
  if (!(target.changedComponents || []).length && !(target.changedAuxiliaryArtifacts || []).length
      && target.sourceRevision !== base.sourceRevision) {
    throw Error('Knowledge-only update must preserve the Console source revision');
  }
  if (base.knowledge) {
    const before = versionParts(base.knowledge.version), after = versionParts(target.knowledge.version);
    const position = before.findIndex((part, i) => part !== after[i]);
    if (position < 0 || after[position] < before[position]) {
      throw Error('Knowledge update must advance its content version; replay or downgrade is not an update');
    }
  }
}

module.exports = { knowledgeReleaseFields, validateKnowledgeRelease, validateKnowledgeTransition };
