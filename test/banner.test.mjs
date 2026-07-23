import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENSPHERE_ANSI_SHADOW,
  printOpenSphereBanner,
  shouldPrintOpenSphereBanner
} from '../src/banner.mjs';

function outputStream(isTTY) {
  let output = '';
  return {
    isTTY,
    write(value) {
      output += value;
    },
    output() {
      return output;
    }
  };
}

test('prints the ANSI Shadow OpenSphere banner for interactive bootstrap', () => {
  const stream = outputStream(true);

  assert.equal(printOpenSphereBanner({ command: 'bootstrap', stream, environment: {} }), true);
  assert.equal(stream.output(), `${OPENSPHERE_ANSI_SHADOW}\n\n`);
  assert.match(stream.output(), /██████╗/);
});

test('does not pollute redirected or machine-readable output', () => {
  const redirected = outputStream(false);
  const version = outputStream(true);

  assert.equal(printOpenSphereBanner({ command: 'bootstrap', stream: redirected, environment: {} }), false);
  assert.equal(printOpenSphereBanner({ command: 'version', stream: version, environment: {} }), false);
  assert.equal(redirected.output(), '');
  assert.equal(version.output(), '');
});

test('supports explicitly disabling the interactive banner', () => {
  const stream = outputStream(true);

  assert.equal(
    shouldPrintOpenSphereBanner({
      command: 'doctor',
      stream,
      environment: { OPENSPHERE_NO_BANNER: '1' }
    }),
    false
  );
});
