import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_ADMIN_RESET_CONFIRMATION,
  resetInitialAdministrator
} from '../src/reset-initial-admin.mjs';

function fakeRuntime({
  channel = 'edge',
  authEnvironment = 'development',
  username = 'opensphere-admin',
  email = 'admin@opensphere.local'
} = {}) {
  const events = [];
  return {
    events,
    installationConfig: () => ({ channel, authEnvironment }),
    initialSetupConfigMap: () => ({
      metadata: { resourceVersion: '9' },
      data: { state: 'complete', username, email }
    }),
    deleteSupabaseOperator: async (value) => events.push(`delete:${value}`),
    resetState: () => events.push('state:required')
  };
}

test('reset-initial-admin removes the test identity and credentials before reopening the Wizard', async () => {
  const fake = fakeRuntime();
  const result = await resetInitialAdministrator({ confirmation: INITIAL_ADMIN_RESET_CONFIRMATION, runtime: fake });
  assert.deepEqual(result, {
    username: 'opensphere-admin',
    email: 'admin@opensphere.local',
    state: 'required'
  });
  assert.deepEqual(fake.events, [
    'delete:admin@opensphere.local',
    'state:required'
  ]);
});

test('reset-initial-admin fails before mutation without exact confirmation', async () => {
  const fake = fakeRuntime();
  await assert.rejects(() => resetInitialAdministrator({ confirmation: 'yes', runtime: fake }), /--confirm RESET-INITIAL-ADMIN/);
  assert.deepEqual(fake.events, []);
});

test('reset-initial-admin is refused outside edge development', async () => {
  for (const config of [
    { channel: 'candidate', authEnvironment: 'production' },
    { channel: 'stable', authEnvironment: 'production' },
    { channel: 'edge', authEnvironment: 'production' }
  ]) {
    const fake = fakeRuntime(config);
    await assert.rejects(
      () => resetInitialAdministrator({ confirmation: INITIAL_ADMIN_RESET_CONFIRMATION, runtime: fake }),
      /restricted to edge\/development/
    );
    assert.deepEqual(fake.events, []);
  }
});
