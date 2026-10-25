import { delimiter } from 'node:path';
import { test } from 'vitest';
import {
applyAgentLaunchEnv,
assert
} from './helpers/test-helpers.js';

const fsTest = process.platform === 'win32' ? test.skip : test;
const winTest = process.platform === 'win32' ? test : test.skip;

test('applyAgentLaunchEnv prepends nodeBinDir and wrapper dir, deduping PATH', () => {
  const launch = {
    childPathPrepend: ['/opt/tools/bin', '/opt/tools/bin'],
  };

  const env = applyAgentLaunchEnv(
    { PATH: ['/usr/bin', '/opt/tools/bin', '/bin', '/usr/bin'].join(delimiter) },
    launch,
    '/node/bin',
    [],
  );

  assert.equal(
    env.PATH,
    ['/node/bin', '/opt/tools/bin', '/usr/bin', '/bin'].join(delimiter),
  );
});

test('applyAgentLaunchEnv appends toolchain dirs so shebang interpreters (e.g. bun) resolve at spawn time', () => {
  // Regression for: Pi (`#!/usr/bin/env bun`) resolved on PATH but its version
  // probe / run spawn failed with exit 127 ("env: bun: No such file or
  // directory") because the spawn PATH didn't include ~/.bun/bin, so detection
  // wrongly marked it unavailable. The fix appends the user toolchain bin dirs
  // (where bun lives) to the spawn PATH.
  const env = applyAgentLaunchEnv(
    { PATH: ['/usr/bin', '/bin'].join(delimiter) },
    { childPathPrepend: ['/opt/homebrew/bin'] },
    '/node/bin',
    ['/home/me/.bun/bin', '/usr/bin'],
  );

  const parts = (env.PATH as string).split(delimiter);
  assert.equal(parts[0], '/node/bin', 'node dir stays first');
  assert.equal(parts[1], '/opt/homebrew/bin', 'wrapper dir stays second');
  assert.ok(
    parts.includes('/home/me/.bun/bin'),
    'toolchain bin dir (where the bun interpreter lives) must be on the spawn PATH',
  );
  assert.equal(
    parts.filter((p: string) => p === '/usr/bin').length,
    1,
    'a toolchain dir already on PATH must not be duplicated',
  );
});

test('applyAgentLaunchEnv updates the Path key in-place without creating a competing PATH key', () => {
  // On Windows, process.env spreads the search path under 'Path' (not 'PATH').
  // This test uses POSIX-compatible paths so it runs cross-platform and
  // exercises the key-casing fix across the full CI matrix.
  const base: NodeJS.ProcessEnv = {
    Path: ['/usr/local/bin', '/usr/bin'].join(delimiter),
  };
  const launch = { childPathPrepend: ['/opt/agent/bin'] };

  const env = applyAgentLaunchEnv(base, launch, '/opt/node/bin', []);

  // Original 'Path' key must be updated in-place.
  assert.ok('Path' in env, 'original Path key must be preserved');
  // No competing uppercase 'PATH' key may be created alongside it.
  assert.equal(env.PATH, undefined, 'no spurious uppercase PATH key must be created');

  const parts = (env.Path as string).split(delimiter);
  assert.equal(parts[0], '/opt/node/bin', 'Node dir must be first in Path');
  assert.equal(parts[1], '/opt/agent/bin', 'wrapper dir must follow Node dir');
  assert.ok(parts.includes('/usr/local/bin'), '/usr/local/bin must be retained');
  assert.ok(parts.includes('/usr/bin'), '/usr/bin must be retained');
});

winTest('applyAgentLaunchEnv injects Node binary dir and wrapper dir into a Windows env that has only Path and no nodejs entry', () => {
  // On Windows, GUI-launched daemons inherit process.env with 'Path' (not
  // 'PATH') and the nodejs install directory is often absent from the
  // search path (desktop shortcut / Electron launcher bypasses shell PATH).
  const windowsBase: NodeJS.ProcessEnv = {
    Path: 'C:\\Windows\\System32;C:\\Windows',
    TEMP: 'C:\\Users\\User\\AppData\\Local\\Temp',
  };
  const launch = { childPathPrepend: ['C:\\Users\\User\\AppData\\Roaming\\npm'] };

  const env = applyAgentLaunchEnv(windowsBase, launch, 'C:\\Program Files\\nodejs', []);

  // Original 'Path' key must be updated in-place — no competing 'PATH' key.
  assert.ok('Path' in env, 'original Path key must be preserved');
  assert.equal(env.PATH, undefined, 'no spurious uppercase PATH key must be created');

  // Windows PATH delimiter is ';'.
  const parts = (env.Path as string).split(';');

  // Node binary directory must come first.
  assert.equal(parts[0], 'C:\\Program Files\\nodejs', 'Node dir must be first in Path');
  // Agent wrapper directory must follow immediately after.
  assert.equal(parts[1], 'C:\\Users\\User\\AppData\\Roaming\\npm', 'wrapper dir must follow Node dir');
  // Original system entries must be fully preserved.
  assert.ok(parts.includes('C:\\Windows\\System32'), 'System32 must be retained');
  assert.ok(parts.includes('C:\\Windows'), 'Windows dir must be retained');
  // No empty entries from splitting.
  assert.ok(parts.every((p: string) => p.length > 0), 'no empty path entries allowed');
});


function codexNativeTargetTriple(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'aarch64-unknown-linux-musl';
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-musl';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  return `${process.platform}-${process.arch}`;
}
