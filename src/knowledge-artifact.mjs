import { createHash } from 'node:crypto';
import { decodeKnowledgeImage, extractKnowledgeLayer as sharedExtract } from './knowledge-oci.mjs';
import tar from 'tar-stream';
import { registryToken } from './release.mjs';
import { fetchWithRetry } from './http.mjs';
import contract from './knowledge-package.cjs';

export const KNOWLEDGE_LOCK_PATH = 'apps/osaa-gateway/knowledge-bundle/lock.json';
export const KNOWLEDGE_SLOT = '__OPENSPHERE_KNOWLEDGE_SOURCES__';
const REPOSITORY = 'opensphere-knowledge';
const BASE = 'https://ghcr.io/v2/opensphere-platform/' + REPOSITORY;
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const HASH = /^sha256:[a-f0-9]{64}$/;
const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);

async function readBounded(response, max) {
  if (!response.ok) throw Error('Knowledge registry read failed: HTTP ' + response.status);
  const length = Number(response.headers.get('content-length') || 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw Error('Knowledge registry object exceeds read budget');
  if (!response.body) throw Error('Knowledge registry response has no body');
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > max) throw Error('Knowledge registry object exceeds read budget');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export const extractKnowledgeLayer = bytes => sharedExtract(bytes, { createExtract: tar.extract });

// The caller obtains the lock from the exact Console source revision already
// admitted by normal release verification. A hash is integrity, not a new trust
// root: this function must not accept chat-supplied locks or mutable image tags.
export async function materializeKnowledge(lock, { fetchImpl = fetch, registryCredentials } = {}) {
  contract.validateLock(lock);
  const guardedFetch = (url, options) => fetchImpl(url, { ...options, redirect: 'error' });
  const auth = await registryToken(REPOSITORY, guardedFetch, registryCredentials);
  async function getObject(kind, expected, max, expectedSize) {
    if (!HASH.test(expected)) throw Error('Invalid Knowledge OCI digest');
    const headers = { authorization: 'Bearer ' + auth.token,
      accept: [...MANIFEST_TYPES, ...INDEX_TYPES].join(', ') };
    let response = await fetchWithRetry(BASE + '/' + kind + '/' + expected,
      { headers, redirect: 'manual' }, { fetchImpl }).catch(() => { throw Error('Knowledge registry transport unavailable'); });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get('location') || '', BASE);
      // GHCR blob CDN only. Never forward registry Authorization to redirects.
      if (kind !== 'blobs' || target.protocol !== 'https:' || target.hostname !== 'pkg-containers.githubusercontent.com'
        || target.username || target.password || (target.port && target.port !== '443')) throw Error('Knowledge registry redirect is not allowed');
      await response.body?.cancel();
      response = await fetchWithRetry(target.href, { redirect: 'error' }, { fetchImpl })
        .catch(() => { throw Error('Knowledge CDN transport unavailable'); });
    }
    const bytes = await readBounded(response, max);
    if (digest(bytes) !== expected || (expectedSize !== undefined && bytes.length !== expectedSize)) throw Error('Knowledge OCI digest or length mismatch');
    return bytes;
  }
  const decoded = await decodeKnowledgeImage(lock.knowledgeImage, { readObject: getObject, createExtract: tar.extract, expectedLock: lock });
  return { ...decoded.projection, registryCredentialsRequired: auth.credentialsRequired };
}

export async function renderKnowledgeManifest(sourceYaml, { readLock, admittedLock, materialize = materializeKnowledge, registryCredentials } = {}) {
  if (!sourceYaml.includes(KNOWLEDGE_SLOT)) {
    if (admittedLock !== undefined) throw Error('Installed Gateway manifest does not support independent Knowledge delivery; update Gateway first');
    return sourceYaml;
  }
  if (sourceYaml.split(KNOWLEDGE_SLOT).length !== 2) throw Error('Knowledge volume slot must occur exactly once');
  const raw = admittedLock === undefined ? await readLock(KNOWLEDGE_LOCK_PATH) : JSON.stringify(admittedLock);
  if (Buffer.byteLength(raw) > 8192) throw Error('Knowledge source lock exceeds read budget');
  const lock = contract.validateLock(JSON.parse(raw));
  const projected = await materialize(lock, { registryCredentials });
  return projected.configMaps.map(cm => JSON.stringify(cm)).join('\n---\n') + '\n---\n'
    + sourceYaml.replace(KNOWLEDGE_SLOT, JSON.stringify(projected.sources));
}
