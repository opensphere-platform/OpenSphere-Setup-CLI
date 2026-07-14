#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveSourceRevision } from '../src/release.mjs';

const [sourceRevision, requestedPath] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '')) {
  throw new Error('Usage: e2e-resolve-source-revision.mjs <40-character-source-revision> <lock-path>');
}
if (!requestedPath) {
  throw new Error('Usage: e2e-resolve-source-revision.mjs <40-character-source-revision> <lock-path>');
}

const lock = await resolveSourceRevision(sourceRevision);
const lockPath = resolve(requestedPath);
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`[완료] ${sourceRevision} rollback release를 ${lock.releaseDigest}로 잠금`);
console.log(`Lock: ${lockPath}`);
