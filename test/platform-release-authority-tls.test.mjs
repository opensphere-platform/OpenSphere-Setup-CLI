import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AUTHORITY_CA,
  AUTHORITY_SERVICE,
  AUTHORITY_SECRET,
  ensurePlatformReleaseAuthorityTls,
  validateAuthorityObjects,
  validateAuthorityService,
} from '../src/platform-release-authority-tls.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('creates one immutable exact TLS custody pair and reuses it without rotation', async () => {
  const objects = new Map();
  const responseLosses = new Set();
  let generations = 0;
  const kubectlFn = (args, options = {}) => {
    if (args[0] === '-n' && args[2] === 'get') {
      const object = objects.get(`${args[3]}/${args[4]}`);
      return object ? JSON.stringify(object) : '';
    }
    if (args[0] === 'create' && args[1] === '-f') {
      const object = JSON.parse(options.input);
      const kind = object.kind.toLowerCase();
      const key = `${kind}/${object.metadata.name}`;
      if (objects.has(key)) throw new Error('AlreadyExists');
      objects.set(key, object);
      if (!responseLosses.has(kind)) {
        responseLosses.add(kind);
        throw new Error(`simulated ${kind} create response loss`);
      }
      return object.metadata.name;
    }
    throw new Error(`unexpected kubectl ${args.join(' ')}`);
  };
  const runFn = (program, args) => {
    generations += 1;
    const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout;
  };
  await ensurePlatformReleaseAuthorityTls({ kubectlFn, runFn });
  assert.equal(generations, 1);
  assert.deepEqual([...responseLosses].sort(), ['configmap', 'secret', 'service']);
  const secret = objects.get(`secret/${AUTHORITY_SECRET}`);
  const configMap = objects.get(`configmap/${AUTHORITY_CA}`);
  const service = objects.get(`service/${AUTHORITY_SERVICE}`);
  assert.equal(validateAuthorityObjects(secret, configMap).secret, secret);
  assert.equal(validateAuthorityService(service), service);
  await ensurePlatformReleaseAuthorityTls({ kubectlFn, runFn });
  assert.equal(generations, 1);
  assert.throws(() => validateAuthorityObjects(secret, {
    ...configMap, data: { 'ca.crt': `${configMap.data['ca.crt']}tampered` },
  }), /public CA differs/);
  assert.throws(() => validateAuthorityObjects({
    ...secret, data: { ...secret.data, 'tls.crt': secret.data['ca.crt'] },
  }, configMap), /certificate chain or exact service SAN/);
});

test('certificate generator and validator close the exact P-256 TLS server profile', () => {
  const generator = readFileSync(resolve(here, '../src/New-PlatformReleaseAuthorityCertificates.ps1'), 'utf8');
  const validator = readFileSync(resolve(here, '../src/platform-release-authority-tls.mjs'), 'utf8');
  assert.match(generator, /NamedCurves\]::nistP256/);
  assert.match(generator, /X509KeyUsageFlags\]::DigitalSignature/);
  assert.match(generator, /1\.3\.6\.1\.5\.5\.7\.3\.1/);
  assert.match(validator, /exactP256PublicKey\(ca\.publicKey\)/);
  assert.match(validator, /exactP256PublicKey\(cert\.publicKey\)/);
  assert.match(validator, /06 03 55 1d 13 01 01 ff 04 02 30 00/);
  assert.match(validator, /06 03 55 1d 0f 01 01 ff 04 04 03 02 07 80/);
  assert.match(validator, /06 03 55 1d 25 01 01 ff 04 0c 30 0a 06 08 2b 06 01 05 05 07 03 01/);
});

test('fails closed when an authority Service exists without the immutable custody pair', async () => {
  const service = {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: AUTHORITY_SERVICE, namespace: 'opensphere-console',
      labels: { app: 'opensphere-platform-release-authority' } },
    spec: { selector: { app: 'opensphere-console-backend' },
      ports: [{ name: 'https', port: 8446, protocol: 'TCP', targetPort: 'release-tls' }] },
  };
  const kubectlFn = (args) => args[0] === '-n' && args[2] === 'get'
    && args[3] === 'service' ? JSON.stringify(service) : '';
  await assert.rejects(ensurePlatformReleaseAuthorityTls({ kubectlFn }), /without the complete/);
});
