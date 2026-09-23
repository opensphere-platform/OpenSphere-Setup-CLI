// Where Setup prepares authority for 22 -> OS Shell -> owner. Chosen at run time, never named in code.
//
// Until 2026-09-23 the candidate profiles (platform-core, HISS, Ceph) accepted exactly
// docker-desktop / https://localhost:1114 / edge, and bootstrap silently skipped them for any
// other install. Every other cluster then "installed" without the preparation 22 depends on.
// Owner decision the same day: a specific cluster or address baked into code or configuration
// is a defect.
//
// What still bounds the risk is kept:
//   - the Kubernetes context the operator invoked, pinned by each adapter for its lifetime;
//   - the Console origin of that installation (bare HTTPS origin, no path or credentials);
//   - the edge channel: candidate/stable stay on HOLD until signed releases exist.
// Profile bytes are still pinned by SHA-256. Only the pinning of *where* is removed.
const fail = (code, message) => Object.assign(new Error(message), { code });
const TARGET_KEYS = new Set(['context', 'channel', 'consoleUrl']);

export function installTarget(scope) {
  // An unexpected field means the caller mixed in something this boundary never reviewed.
  if (!scope || typeof scope !== 'object' || Object.keys(scope).some(key => !TARGET_KEYS.has(key))) {
    throw fail('INVALID_SCOPE', 'Unexpected preparation target');
  }
  const context = typeof scope.context === 'string' ? scope.context.trim() : '';
  // A leading dash would read as a kubectl flag; whitespace never names a real context.
  if (!context || context.startsWith('-') || /\s/.test(context)) {
    throw fail('INVALID_SCOPE', 'An explicit Kubernetes context is required');
  }
  if (scope.channel !== 'edge') {
    throw fail('INVALID_SCOPE', 'Candidate preparation profiles are approved for the edge channel only');
  }
  let url;
  try { url = new URL(scope.consoleUrl); } catch { throw fail('INVALID_SCOPE', 'Invalid Console URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw fail('INVALID_SCOPE', 'Console URL must be a bare HTTPS origin');
  }
  return Object.freeze({ context, channel: 'edge', consoleUrl: url.origin });
}

// Profiles published before 2026-09-23 still record the environment they were first approved in
// (`{context, consoleUrl, channel}` or `"docker-desktop/localhost/edge"`). That is provenance, not
// a target restriction; only the channel inside it binds.
export function profileChannel(scope) {
  if (typeof scope === 'string') return scope.split('/').at(-1);
  return scope && typeof scope === 'object' ? scope.channel : undefined;
}
