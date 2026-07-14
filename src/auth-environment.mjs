const ENVIRONMENTS = new Set(['development', 'production']);

export function selectAuthEnvironment(channel, supplied) {
  const value = supplied ?? (channel === 'edge' ? 'development' : 'production');
  if (!ENVIRONMENTS.has(value)) throw new Error(`Unsupported authentication environment: ${value}`);
  if (channel !== 'edge' && value !== 'production') {
    throw new Error(`${channel} requires --auth-environment production; TOTP cannot be relaxed on a promotion channel`);
  }
  return value;
}
