import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseConsoleSourceLock, readConsoleSourceLock } from './resolve-console-source-lock.mjs';

function checkedGit(checkout, args) {
  const result = spawnSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Console source Git verification failed: git ${args.join(' ')}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function canonicalRemote(url) {
  return url.endsWith('.git') ? url : `${url}.git`;
}

export function verifyConsoleSourceTransition(current, previous, isAncestor) {
  if (!previous) return Object.freeze({ mode: 'bootstrap', previousRevision: null });
  if (current.contract !== previous.contract
      || current.githubRepository !== previous.githubRepository
      || current.canonicalUrl !== previous.canonicalUrl) {
    throw new Error('Console source transition changed canonical authority');
  }
  if (current.revision === previous.revision) {
    return Object.freeze({ mode: 'unchanged', previousRevision: previous.revision });
  }
  if (!isAncestor(previous.revision, current.revision)) {
    throw new Error('Console source lock transition must be forward-only');
  }
  return Object.freeze({ mode: 'forward', previousRevision: previous.revision });
}

export function verifyConsoleSourceCheckout(checkout, {
  current = readConsoleSourceLock(),
  previous = undefined,
  transitionMode = 'current-only',
  gitFn = checkedGit,
  fetchFn = (path) => gitFn(path, ['fetch', '--prune', '--no-tags', 'origin', 'main']),
} = {}) {
  if (!['bootstrap', 'previous', 'current-only'].includes(transitionMode)) {
    throw new Error('Console source checkout transition mode is invalid');
  }
  if ((transitionMode === 'previous') !== Boolean(previous)) {
    throw new Error('Console source checkout previous lock boundary is invalid');
  }
  if (transitionMode === 'bootstrap' && previous) {
    throw new Error('Console source checkout bootstrap cannot have a previous lock');
  }
  const origin = gitFn(checkout, ['remote', 'get-url', 'origin']);
  if (canonicalRemote(origin) !== current.canonicalUrl) {
    throw new Error('Console source checkout origin is not canonical');
  }
  const head = gitFn(checkout, ['rev-parse', 'HEAD']);
  if (head !== current.revision || gitFn(checkout, ['cat-file', '-t', head]) !== 'commit') {
    throw new Error('Console source checkout does not match the locked commit');
  }
  fetchFn(checkout);
  const originMain = gitFn(checkout, ['rev-parse', 'refs/remotes/origin/main']);
  const ancestor = (older, newer) => {
    try {
      gitFn(checkout, ['merge-base', '--is-ancestor', older, newer]);
      return true;
    } catch {
      return false;
    }
  };
  if (!ancestor(current.revision, originMain)) {
    throw new Error('Console source lock is not reachable from fetched canonical origin/main');
  }
  const transition = transitionMode === 'current-only'
    ? Object.freeze({ mode: 'current-only', previousRevision: null })
    : verifyConsoleSourceTransition(current, previous, ancestor);
  if (transitionMode === 'bootstrap' && transition.mode !== 'bootstrap') {
    throw new Error('Console source checkout bootstrap boundary is invalid');
  }
  return Object.freeze({
    contract: current.contract,
    canonicalUrl: current.canonicalUrl,
    revision: current.revision,
    originMain,
    transitionMode: transition.mode,
    previousRevision: transition.previousRevision,
  });
}

function parseArguments(args) {
  const values = { checkout: '', previousLock: '', transitionMode: '' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--checkout' && args[index + 1] && !values.checkout) values.checkout = args[++index];
    else if (arg === '--previous-lock' && args[index + 1] && !values.transitionMode) {
      values.previousLock = args[++index];
      values.transitionMode = 'previous';
    } else if (arg === '--allow-bootstrap' && !values.transitionMode) {
      values.transitionMode = 'bootstrap';
    } else if (arg === '--current-only' && !values.transitionMode) {
      values.transitionMode = 'current-only';
    } else throw new Error(`Unknown or incomplete Console source verification argument: ${arg}`);
  }
  if (!values.checkout || !values.transitionMode) {
    throw new Error('Console source verification requires checkout and one transition mode');
  }
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArguments(process.argv.slice(2));
  const previous = args.previousLock
    ? parseConsoleSourceLock(readFileSync(args.previousLock, 'utf8')) : undefined;
  process.stdout.write(`${JSON.stringify(verifyConsoleSourceCheckout(args.checkout, {
    previous, transitionMode: args.transitionMode,
  }))}\n`);
}
