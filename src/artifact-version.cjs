'use strict';
// Version interpretation only. This module does not allocate or reserve BUILD.
function parseArtifactVersion(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  let match, year, month, day, hour, minute, build = null, format;
  if ((match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value))) {
    [, year, month, day, hour, minute] = match; format = 'legacy';
  } else if ((match = /^(\d{2})\.([1-9]|1[0-2])(\d{2})\.(\d{2})(\d{2})\.(0|[1-9]\d{0,19})$/.exec(value))) {
    [, year, month, day, hour, minute, build] = match; year = 2000 + Number(year); format = 'build';
  } else return null;
  if (match[0] !== value) return null;
  [year, month, day, hour, minute] = [year, month, day, hour, minute].map(Number);
  if (year < 2000 || year > 2099 || hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1) return null;
  const time = Date.UTC(year, month - 1, day, hour, minute), date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { value, format, time, build };
}
function compareArtifactVersions(left, right) {
  const a = parseArtifactVersion(left), b = parseArtifactVersion(right);
  if (!a || !b) throw new Error('InvalidArtifactVersion');
  if (a.format === 'build' && b.format === 'build') {
    const x = BigInt(a.build), y = BigInt(b.build);
    if (x === y && a.value !== b.value) throw new Error('BuildNumberReused');
    return x > y ? 1 : x < y ? -1 : 0;
  }
  if (a.time !== b.time) return a.time > b.time ? 1 : -1;
  // A new-format build in the same minute follows the legacy artifact.
  return a.format === b.format ? 0 : a.format === 'build' ? 1 : -1;
}
function assertNewArtifactVersion(value, previous) {
  if (parseArtifactVersion(value)?.format !== 'build') throw new Error('IssuedBuildArtifactVersionRequired');
  if (previous && compareArtifactVersions(value, previous) <= 0) throw new Error('ArtifactVersionNotIncreasing');
  return value;
}
module.exports = { parseArtifactVersion, compareArtifactVersions, assertNewArtifactVersion };
