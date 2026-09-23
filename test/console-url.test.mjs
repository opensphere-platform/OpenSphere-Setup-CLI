import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseAllDocuments} from 'yaml';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  configureShellServiceEndpoint,
  defaultConsoleUrl,
  isLegacyEdgeLoopbackHttpOrigin,
  normalizeConsoleUrl
} from '../src/console-url.mjs';
const CONSOLE_SOURCE=process.env.OPENSPHERE_CONSOLE_SOURCE
  ?pathToFileURL(resolve(process.env.OPENSPHERE_CONSOLE_SOURCE)+sep)
  :new URL('./fixtures/console-contract-v66/',import.meta.url);

test('actual Console manifest uses the admin origin port and preserves other resources',()=>{
  const source=readFileSync(new URL('deploy/opensphere-console.yaml',CONSOLE_SOURCE),'utf8');
  const original=parseAllDocuments(source).map(doc=>doc.toJSON());
  for(const [origin,port,targetPort,name] of [
    ['https://console.example.test',443,8443,'https'],
    ['https://console.example.test:9443',9443,8443,'https'],
    ['https://localhost:1114',1114,8443,'https'],
    ['http://localhost:8090',8090,8080,'http'],
    ['http://localhost',80,8080,'http'],
  ]){
    const rendered=configureShellServiceEndpoint(source,origin);
    const documents=parseAllDocuments(rendered).map(doc=>{assert.equal(doc.errors.length,0);return doc.toJSON();});
    const service=documents.find(doc=>doc.kind==='Service'&&doc.metadata.name==='opensphere-console-ext');
    assert.deepEqual(service.spec.ports,[{name,port,targetPort}]);
    assert.deepEqual(documents.filter(doc=>doc!==service),original.filter(doc=>doc.kind!=='Service'||doc.metadata.name!=='opensphere-console-ext'));
    assert.equal(configureShellServiceEndpoint(rendered,origin),rendered,'render is idempotent');
  }
});

test('ambiguous and unexpected Console Service shapes fail instead of retaining a wrong port',()=>{
  const source=readFileSync(new URL('deploy/opensphere-console.yaml',CONSOLE_SOURCE),'utf8');
  const service=source.slice(source.lastIndexOf('---'));
  assert.throws(()=>configureShellServiceEndpoint(source+'\n'+service,'https://console.example.test'),/exactly one/);
  assert.throws(()=>configureShellServiceEndpoint(source.replace('targetPort: 8443','targetPort: 1234'),'https://console.example.test'),/governed/);
  assert.throws(()=>configureShellServiceEndpoint(source.replace('port: 1114','port: 1114\n      protocol: UDP'),'https://console.example.test'),/governed/);
});

test('Console endpoint is one exact origin shared by browser, Supabase and CLI', () => {
  assert.equal(normalizeConsoleUrl('https://console.example.test/'), 'https://console.example.test');
  assert.equal(normalizeConsoleUrl('https://console.example.test:9443'), 'https://console.example.test:9443');
});

test('every managed channel has one canonical HTTPS localhost default', () => {
  assert.equal(defaultConsoleUrl('edge', 'development'), 'https://localhost:1114');
  assert.equal(defaultConsoleUrl('edge', 'production'), 'https://localhost:1114');
  assert.equal(defaultConsoleUrl('stable', 'production'), 'https://localhost:1114');
  assert.equal(normalizeConsoleUrl('http://localhost:8090/'), 'http://localhost:8090');
  assert.equal(normalizeConsoleUrl('http://127.0.0.1:8090'), 'http://127.0.0.1:8090');
});

test('only the temporary edge/development loopback HTTP default is repairable in place', () => {
  assert.equal(isLegacyEdgeLoopbackHttpOrigin({
    channel: 'edge', authEnvironment: 'development',
    storedUrl: 'http://localhost:8090', requestedUrl: 'https://localhost:8090'
  }), true);
  assert.equal(isLegacyEdgeLoopbackHttpOrigin({
    channel: 'edge', authEnvironment: 'production',
    storedUrl: 'http://localhost:8090', requestedUrl: 'https://localhost:8090'
  }), false);
  assert.equal(isLegacyEdgeLoopbackHttpOrigin({
    channel: 'edge', authEnvironment: 'development',
    storedUrl: 'http://127.0.0.1:8090', requestedUrl: 'https://localhost:8090'
  }), false);
});

test('loopback HTTP selects nginx HTTP without weakening the external HTTPS listener', () => {
  const manifest = `apiVersion: v1
kind: Service
metadata:
  name: opensphere-console-ext
  namespace: opensphere-console
spec:
  ports:
    - name: https
      port: 8090
      targetPort: 8443
`;
  assert.match(configureShellServiceEndpoint(manifest, 'http://localhost:8090'), /name: http[\s\S]*targetPort: 8080/);
  assert.equal(configureShellServiceEndpoint(manifest, 'https://localhost:8090'), manifest);
});

test('Console endpoint rejects ambiguous or remote insecure browser origins', () => {
  for (const value of [
    'http://console.example.test',
    'https://user:secret@console.example.test',
    'https://console.example.test/manage',
    'https://console.example.test/?debug=1',
    'not-a-url'
  ]) {
    assert.throws(() => normalizeConsoleUrl(value), /--console/);
  }
});
