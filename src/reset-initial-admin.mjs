import { kubectl } from './process.mjs';
import { withServicePortForward } from './port-forward.mjs';

export const INITIAL_ADMIN_RESET_CONFIRMATION = 'RESET-INITIAL-ADMIN';

function getJson(namespace, kind, name) {
  return JSON.parse(kubectl(['-n', namespace, 'get', kind, name, '-o', 'json'], { capture: true }));
}

function installationConfig() {
  const lock = getJson('opensphere-console', 'configmap', 'opensphere-installation-lock');
  return JSON.parse(lock.data?.['config.json'] || '{}');
}

function initialSetupConfigMap() {
  return getJson('opensphere-console', 'configmap', 'opensphere-initial-admin');
}

function serviceRoleKey() {
  const secret = getJson('opensphere-console-data', 'secret', 'opensphere-supabase-secrets');
  const encoded = secret.data?.['service-role-key'];
  if (!encoded) throw new Error('Supabase service-role credential is unavailable');
  return Buffer.from(encoded, 'base64').toString('utf8');
}

async function supabaseRequest(baseUrl, key, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      apikey: key,
      authorization: `Bearer ${key}`,
      ...options.headers
    }
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, json };
}

async function deleteSupabaseOperator(email) {
  const key = serviceRoleKey();
  await withServicePortForward({
    namespace: 'opensphere-console-data',
    service: 'opensphere-supabase-auth',
    remotePort: 9999,
    protocol: 'http',
    label: 'Supabase initial administrator reset'
  }, async (baseUrl) => {
    const listed = await supabaseRequest(baseUrl, key, '/admin/users?page=1&per_page=1000');
    if (listed.status !== 200) throw new Error(`Supabase user listing failed: HTTP ${listed.status}`);
    const users = Array.isArray(listed.json?.users) ? listed.json.users : [];
    const user = users.find((candidate) => String(candidate.email ?? '').toLowerCase() === email.toLowerCase());
    if (!user) return;
    if (!/^[0-9a-f-]{36}$/i.test(String(user.id))) throw new Error('Supabase initial administrator has an invalid UUID');
    // auth.users is intentionally ON DELETE RESTRICT. Remove the disposable
    // Console projection first; its role/CLI rows cascade. If any durable
    // governed record still references the operator, PostgreSQL refuses this
    // development reset rather than silently orphaning evidence.
    kubectl([
      '-n', 'opensphere-console-data', 'exec', 'statefulset/opensphere-supabase-postgres', '--',
      'sh', '-ec',
      `PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "DELETE FROM console.operator WHERE user_id='${user.id}'"`
    ], { capture: true });
    const deleted = await supabaseRequest(baseUrl, key, `/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'DELETE'
    });
    if (![200, 204, 404].includes(deleted.status)) {
      throw new Error(`Initial Supabase administrator delete failed: HTTP ${deleted.status}`);
    }
  });
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
  deleteSupabaseOperator,
  resetState
};

// Development-only recovery for a first-access Wizard completed with a
// disposable Supabase operator. Deleting auth.users cascades through the
// Console operator, role assignment, CLI-device and API-token foreign keys.
export async function resetInitialAdministrator({ confirmation, runtime = defaultRuntime } = {}) {
  if (confirmation !== INITIAL_ADMIN_RESET_CONFIRMATION) {
    throw new Error(`reset-initial-admin requires --confirm ${INITIAL_ADMIN_RESET_CONFIRMATION}`);
  }
  const config = runtime.installationConfig();
  if (config.channel !== 'edge' || config.authEnvironment !== 'development') {
    throw new Error('reset-initial-admin is restricted to edge/development installations');
  }
  const state = runtime.initialSetupConfigMap();
  const email = state.data?.email;
  if (!email) throw new Error('Initial administrator state has no email');
  await runtime.deleteSupabaseOperator(email);
  runtime.resetState(state);
  return { username: state.data?.username, email, state: 'required' };
}
