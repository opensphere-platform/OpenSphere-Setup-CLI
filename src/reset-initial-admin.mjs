import https from 'node:https';
import { kubectl } from './process.mjs';
import { withServicePortForward } from './port-forward.mjs';

export const INITIAL_ADMIN_RESET_CONFIRMATION = 'RESET-INITIAL-ADMIN';

function getJson(kind, name) {
  return JSON.parse(kubectl(['-n', 'opensphere-console', 'get', kind, name, '-o', 'json'], { capture: true }));
}

function installationConfig() {
  const lock = getJson('configmap', 'opensphere-installation-lock');
  return JSON.parse(lock.data?.['config.json'] || '{}');
}

function initialSetupConfigMap() {
  return getJson('configmap', 'opensphere-initial-admin');
}

function roleManagerToken() {
  const secret = getJson('secret', 'opensphere-rolemgr-kanidm');
  const encoded = secret.data?.token;
  if (!encoded) throw new Error('Console role-manager credential is unavailable');
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function request(baseUrl, method, path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = https.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      rejectUnauthorized: false,
      headers: { accept: 'application/json', authorization: `Bearer ${token}` }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: response.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function deletePerson(username) {
  const token = roleManagerToken();
  await withServicePortForward({
    namespace: 'opensphere-console',
    service: 'opensphere-console-auth',
    remotePort: 8443,
    label: 'Kanidm administrator reset'
  }, async (baseUrl) => {
    const deleted = await request(baseUrl, 'DELETE', `/v1/person/${encodeURIComponent(username)}`, token);
    if (![200, 204, 404].includes(deleted.status)) {
      throw new Error(`Initial administrator delete failed: HTTP ${deleted.status}`);
    }
    const check = await request(baseUrl, 'GET', `/v1/person/${encodeURIComponent(username)}`, token);
    if (check.status !== 404 && !(check.status === 200 && check.json === null)) {
      throw new Error('Initial administrator still exists after reset');
    }
  });
}

function clearData(kind, name) {
  try {
    kubectl([
      '-n', 'opensphere-console', 'patch', kind, name, '--type=merge',
      '-p', JSON.stringify({ data: null })
    ], { capture: true });
  } catch (error) {
    if (!String(error.message).includes('NotFound')) throw error;
  }
}

function resetState(configMap) {
  const document = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'opensphere-initial-admin',
      namespace: 'opensphere-console',
      resourceVersion: configMap.metadata?.resourceVersion
    },
    data: {
      state: 'required',
      username: configMap.data?.username || 'opensphere-admin',
      displayName: configMap.data?.displayName || 'OpenSphere Administrator',
      email: configMap.data?.email || 'admin@opensphere.local'
    }
  };
  kubectl(['replace', '-f', '-'], { capture: true, input: `${JSON.stringify(document)}\n` });
}

const defaultRuntime = {
  installationConfig,
  initialSetupConfigMap,
  deletePerson,
  clearData,
  resetState
};

// Development-only recovery for a first-access Wizard completed with a disposable
// test identity. Candidate/stable and production policy require audited IGA recovery.
export async function resetInitialAdministrator({ confirmation, runtime = defaultRuntime } = {}) {
  if (confirmation !== INITIAL_ADMIN_RESET_CONFIRMATION) {
    throw new Error(`reset-initial-admin requires --confirm ${INITIAL_ADMIN_RESET_CONFIRMATION}`);
  }
  const config = runtime.installationConfig();
  if (config.channel !== 'edge' || config.authEnvironment !== 'development') {
    throw new Error('reset-initial-admin is restricted to edge/development installations');
  }
  const state = runtime.initialSetupConfigMap();
  const username = state.data?.username;
  if (!username) throw new Error('Initial administrator state has no username');

  await runtime.deletePerson(username);
  for (const [kind, name] of [
    ['configmap', 'opensphere-console-auth-pats'],
    ['configmap', 'opensphere-console-auth-cli-devices'],
    ['secret', 'opensphere-console-auth-cli-flows'],
    ['secret', 'opensphere-console-auth-codes']
  ]) runtime.clearData(kind, name);
  runtime.resetState(state);
  return { username, state: 'required' };
}
