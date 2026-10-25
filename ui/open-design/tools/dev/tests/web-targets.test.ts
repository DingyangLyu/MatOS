import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_APPS, resolveStartApps, resolveStopApps, resolveToolDevConfig } from '../src/config.js';

test('the research edition starts only the daemon and web without Electron', () => {
  assert.deepEqual(ALL_APPS, ['daemon', 'web']);
  assert.deepEqual(resolveStartApps(undefined), ['daemon', 'web']);
  assert.deepEqual(resolveStopApps(undefined), ['web', 'daemon']);
  assert.deepEqual(Object.keys(resolveToolDevConfig().apps).sort(), ['daemon', 'web']);
  assert.throws(() => resolveStartApps('desktop'), /unsupported/);
});
