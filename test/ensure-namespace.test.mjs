import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureNamespace } from '../src/bootstrap.mjs';

// RKE2 2026-10-23: every upgrade re-applied a bare Namespace over each managed namespace, which removed the labels
// (PSA "restricted" among them) of namespaces whose components were not in that component lock.
test('an existing namespace is left alone, so its labels survive an upgrade', () => {
  const calls = [];
  const run = (args) => { calls.push(args.join(' ')); return args[0] === 'get' ? 'namespace/opensphere-shell-sessions\n' : ''; };
  ensureNamespace('opensphere-shell-sessions', { run });
  assert.deepEqual(calls, ['get namespace opensphere-shell-sessions --ignore-not-found -o name']);
});

test('a missing namespace is created', () => {
  const calls = [];
  const run = (args, options) => {
    calls.push({ args: args.join(' '), input: options?.input });
    if (args[0] === 'get') return '';
    if (args[0] === 'create') return 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: opensphere-foundation\n';
    return '';
  };
  ensureNamespace('opensphere-foundation', { run });
  assert.deepEqual(calls.map(c => c.args), [
    'get namespace opensphere-foundation --ignore-not-found -o name',
    'create namespace opensphere-foundation --dry-run=client -o yaml',
    'apply -f -',
  ]);
  assert.match(calls[2].input, /name: opensphere-foundation/);
});
