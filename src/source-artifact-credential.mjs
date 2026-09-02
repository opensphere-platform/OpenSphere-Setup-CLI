const GITHUB_CONTENTS_ROOT = 'https://api.github.com/repos/opensphere-platform/OpenSphere-console/contents';
export const SOURCE_ARTIFACT_RAW_ROOT = 'https://raw.githubusercontent.com/opensphere-platform/OpenSphere-console';
export const SOURCE_ARTIFACT_TOKEN_ENV = 'OPENSPHERE_CONSOLE_SOURCE_TOKEN';

const credentialTokens = new WeakMap();
const SOURCE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u;
const SOURCE_REVISION = /^[a-f0-9]{40}$/u;

function validPath(path) {
  return SOURCE_PATH.test(path)
    && !path.includes('//')
    && !path.split('/').some((part) => part === '.' || part === '..');
}

export function takeSourceArtifactCredential(environment = process.env) {
  if (!Object.hasOwn(environment, SOURCE_ARTIFACT_TOKEN_ENV)) return null;
  const value = String(environment[SOURCE_ARTIFACT_TOKEN_ENV] ?? '');
  delete environment[SOURCE_ARTIFACT_TOKEN_ENV];
  const token = value.trim();
  if (value !== token || token.length < 20 || token.length > 1024 || /[\s\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error(SOURCE_ARTIFACT_TOKEN_ENV + ' must contain one bounded GitHub Contents read token');
  }
  const credential = Object.freeze({ type: 'github-contents-read/v1' });
  credentialTokens.set(credential, token);
  return credential;
}

export function sourceArtifactRequest(sourceRevision, path, credential = null) {
  if (!SOURCE_REVISION.test(sourceRevision ?? '')) {
    throw new Error('Console source artifact revision must be one full lowercase commit');
  }
  if (!validPath(path ?? '')) {
    throw new Error('Console source artifact path is invalid');
  }
  if (!credential) {
    return Object.freeze({
      url: SOURCE_ARTIFACT_RAW_ROOT + '/' + sourceRevision + '/' + path,
      options: Object.freeze({ redirect: 'error' })
    });
  }
  const token = credentialTokens.get(credential);
  if (!token) throw new Error('Console source artifact credential is not trusted');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(GITHUB_CONTENTS_ROOT + '/' + encodedPath);
  url.searchParams.set('ref', sourceRevision);
  return Object.freeze({
    url: url.href,
    options: Object.freeze({
      redirect: 'error',
      headers: Object.freeze({
        Accept: 'application/vnd.github.raw+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'opensphere-setup-cli'
      })
    })
  });
}
