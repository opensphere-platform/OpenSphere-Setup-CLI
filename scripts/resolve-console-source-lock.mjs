import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRACT = 'opensphere-setup-console-source/v1';
const GITHUB_REPOSITORY = 'opensphere-platform/OpenSphere-console';
const CANONICAL_URL = 'https://github.com/opensphere-platform/OpenSphere-console.git';
const EXACT_KEYS = ['canonicalUrl', 'contract', 'githubRepository', 'revision'];

function exactKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(EXACT_KEYS);
}

export function parseConsoleSourceLock(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Console source lock must be valid JSON');
  }
  if (!exactKeys(value)) throw new Error('Console source lock must use the exact closed schema');
  if (value.contract !== CONTRACT) throw new Error('Console source lock contract is invalid');
  if (value.githubRepository !== GITHUB_REPOSITORY
      || value.canonicalUrl !== CANONICAL_URL) {
    throw new Error('Console source lock repository is not canonical');
  }
  if (!/^[a-f0-9]{40}$/u.test(value.revision)) {
    throw new Error('Console source lock revision must be a full lowercase commit');
  }
  return Object.freeze({ ...value });
}

export function readConsoleSourceLock() {
  return parseConsoleSourceLock(readFileSync(
    new URL('../console-source.lock.json', import.meta.url), 'utf8'
  ));
}

if (process.argv[1]
    && pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]))).href === import.meta.url) {
  process.stdout.write(`${JSON.stringify(readConsoleSourceLock())}\n`);
}
