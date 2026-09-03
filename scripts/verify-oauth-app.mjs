#!/usr/bin/env node
import {GITHUB_OAUTH_CLIENT_ID} from '../src/github-oauth-app.mjs';
import {createGitHubRegistryAuth} from '../src/github-registry-auth.mjs';
if (!/^[A-Za-z0-9._-]{8,128}$/u.test(GITHUB_OAUTH_CLIENT_ID) || /^(?:gh[pousr]_|github_pat_)/u.test(GITHUB_OAUTH_CLIENT_ID)) {
  process.stderr.write('Publication blocked: register the OpenSphere GitHub OAuth App, enable Device Flow, and configure its public Client ID. Never use a PAT as the Client ID.\n');
  process.exitCode=1;
} else {
  try {
    await createGitHubRegistryAuth().start(GITHUB_OAUTH_CLIENT_ID);
    process.stdout.write('Registered OAuth App accepted Device Flow. This probe does not prove user authorization or GHCR access.\n');
  } catch (error) {
    process.stderr.write('OAuth App Device Flow probe failed: '+String(error.code || 'ProviderUnavailable')+'\n');
    process.exitCode=1;
  }
}
