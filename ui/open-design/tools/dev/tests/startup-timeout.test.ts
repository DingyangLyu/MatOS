import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDevStartupTimeout } from '../src/sidecar-client.js';

test('cold-storage development startup overrides are bounded and preserve the default', () => {
  assert.equal(resolveDevStartupTimeout({}), 35000);
  assert.equal(resolveDevStartupTimeout({ OD_TOOLS_DEV_STARTUP_TIMEOUT_MS: '120000' }), 120000);
  for (const value of ['0', '-1', 'Infinity', 'abc', '300001']) {
    assert.equal(resolveDevStartupTimeout({ OD_TOOLS_DEV_STARTUP_TIMEOUT_MS: value }), 35000);
  }
});
