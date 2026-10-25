import * as platform from '@open-design/platform';
import { homedir } from 'node:os';
import { dirname,relative,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test,vi } from 'vitest';
import {
assert,chmodSync,
join,minimalAgentDef,mkdirSync,mkdtempSync,
resolveAgentExecutable,rmSync,spawnEnvForAgent,tmpdir,withEnvSnapshot,withPlatform,writeFileSync
} from './helpers/test-helpers.js';

const fsTest = process.platform === 'win32' ? test.skip : test;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');


test('spawnEnvForAgent restores the workspace runtime PATH for stdio MCP tools', () => {
  const base = {
    PATH: '/app/bin:/usr/bin',
    MATOS_WORKSPACE_RUNTIME_PATH: '/home/workspace/.local/bin:/opt/matos-tools/conda/bin:/usr/bin',
  };
  const env = spawnEnvForAgent('matos', base);

  assert.equal(
    env.PATH,
    '/home/workspace/.local/bin:/opt/matos-tools/conda/bin:/usr/bin',
  );
  assert.equal(base.PATH, '/app/bin:/usr/bin');
});

test('spawnEnvForAgent keeps an explicit configured PATH above the workspace runtime PATH', () => {
  const env = spawnEnvForAgent(
    'matos',
    {
      PATH: '/app/bin:/usr/bin',
      MATOS_WORKSPACE_RUNTIME_PATH: '/opt/matos-tools/conda/bin:/usr/bin',
    },
    { PATH: '/custom/agent/bin:/usr/bin' },
  );

  assert.equal(env.PATH, '/custom/agent/bin:/usr/bin');
});

test('spawnEnvForAgent reapplies sandbox state roots after configured env overrides', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'od-agent-env-sandbox-'));
  try {
    const env = spawnEnvForAgent(
      'matos',
      {
        OD_DATA_DIR: dataDir,
        OD_SANDBOX_MODE: '1',
        PATH: '/usr/bin',
      },
      {
        MATOS_BIN: '/Users/test/bin/matos',
        OD_DATA_DIR: '/host/path/.od',
      },
    );
    assert.equal(env.OD_DATA_DIR, dataDir);
    assert.equal(env.OD_AGENT_HOME, join(dataDir, 'sandbox', 'agent-home'));
    assert.equal(env.HOME, join(dataDir, 'sandbox', 'agent-home'));
    assert.equal(env.XDG_CONFIG_HOME, join(dataDir, 'sandbox', 'config'));
    assert.equal(env.MATOS_BIN, '/Users/test/bin/matos');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spawnEnvForAgent keeps sandbox roots pinned to the base OD_DATA_DIR', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'od-agent-env-sandbox-base-'));
  try {
    const env = spawnEnvForAgent(
      'matos',
      {
        OD_DATA_DIR: dataDir,
        OD_SANDBOX_MODE: '1',
        PATH: '/usr/bin',
      },
      {
        OD_DATA_DIR: '/host/path/.od',
      },
    );

    assert.equal(env.OD_DATA_DIR, dataDir);
    assert.equal(env.OD_AGENT_HOME, join(dataDir, 'sandbox', 'agent-home'));
    assert.equal(env.HOME, join(dataDir, 'sandbox', 'agent-home'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spawnEnvForAgent resolves relative OD_DATA_DIR before applying sandbox roots', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'od-agent-env-sandbox-relative-'));
  try {
    const relativeDataDir = relative(repoRoot, dataDir);
    const env = spawnEnvForAgent(
      'matos',
      {
        OD_DATA_DIR: relativeDataDir,
        OD_SANDBOX_MODE: '1',
        PATH: '/usr/bin',
      },
      {},
    );

    assert.equal(env.OD_DATA_DIR, dataDir);
    assert.equal(env.OD_AGENT_HOME, join(dataDir, 'sandbox', 'agent-home'));
    assert.equal(env.HOME, join(dataDir, 'sandbox', 'agent-home'));
    assert.equal(env.XDG_CONFIG_HOME, join(dataDir, 'sandbox', 'config'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spawnEnvForAgent applies system proxy env to all agent runtimes before base env overrides', () => {
  const env = spawnEnvForAgent(
    'matos',
    {
      HTTPS_PROXY: 'http://user-env:9000',
      PATH: '/usr/bin',
    },
    {},
    {
      HTTP_PROXY: 'http://system-http:7890',
      HTTPS_PROXY: 'http://system-https:7891',
      ALL_PROXY: 'socks5://system-socks:1080',
      NO_PROXY: '.local,localhost',
      NODE_USE_ENV_PROXY: '1',
    },
  );

  assert.equal(env.HTTP_PROXY, 'http://system-http:7890');
  assert.equal(env.HTTPS_PROXY, 'http://user-env:9000');
  assert.equal(env.ALL_PROXY, 'socks5://system-socks:1080');
  assert.equal(env.NO_PROXY, '.local,localhost');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.PATH, '/usr/bin');
});

test('spawnEnvForAgent resolves system proxy env for each default agent launch', () => {
  const proxySpy = vi.spyOn(platform, 'resolveSystemProxyEnv').mockReturnValue({
    HTTPS_PROXY: 'http://system-https:7891',
    NODE_USE_ENV_PROXY: '1',
  });

  try {
    const env = spawnEnvForAgent('matos', { PATH: '/usr/bin' });

    assert.deepEqual(proxySpy.mock.calls, [[]]);
    assert.equal(env.HTTPS_PROXY, 'http://system-https:7891');
    assert.equal(env.PATH, '/usr/bin');
  } finally {
    proxySpy.mockRestore();
  }
});

test('spawnEnvForAgent lets explicit lowercase proxy env override system uppercase proxy env', () => {
  const env = spawnEnvForAgent(
    'matos',
    {
      https_proxy: 'http://user-lowercase:9000',
      PATH: '/usr/bin',
    },
    {},
    {
      HTTPS_PROXY: 'http://system-uppercase:7891',
      NODE_USE_ENV_PROXY: '1',
    },
  );

  assert.equal(env.HTTPS_PROXY, 'http://user-lowercase:9000');
  if (process.platform !== 'win32') {
    assert.equal(env.https_proxy, 'http://user-lowercase:9000');
  }
});

test('spawnEnvForAgent enables Node env proxy support for inherited lowercase proxy env', () => {
  const env = spawnEnvForAgent(
    'matos',
    {
      http_proxy: 'http://user-lowercase:9000',
      PATH: '/usr/bin',
    },
    {},
    {},
  );

  assert.equal(env.HTTP_PROXY, 'http://user-lowercase:9000');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  if (process.platform !== 'win32') {
    assert.equal(env.http_proxy, 'http://user-lowercase:9000');
  }
});

test('spawnEnvForAgent expands configured env home paths', () => {
  const env = spawnEnvForAgent('matos', { PATH: '/usr/bin' }, {
    MATOS_BIN: '~/bin/matos',
    MATOS_CACHE: '~',
  });

  assert.equal(env.MATOS_BIN, join(homedir(), 'bin', 'matos'));
  assert.equal(env.MATOS_CACHE, homedir());
  assert.equal(env.PATH, '/usr/bin');
});


test('resolveAgentExecutable prefers a configured MATOS_BIN override over PATH resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-matos-bin-'));
  try {
    return withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], () => {
      const configured = join(dir, 'matos-custom');
      writeFileSync(configured, '#!/bin/sh\nexit 0\n');
      chmodSync(configured, 0o755);
      process.env.PATH = '';
      process.env.OD_AGENT_HOME = dir;

      const resolved = resolveAgentExecutable(
        minimalAgentDef({ id: 'matos', bin: 'matos' }),
        { MATOS_BIN: configured },
      );

      assert.equal(resolved, configured);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});




test('resolveAgentExecutable ignores relative MATOS_BIN overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-matos-bin-rel-'));
  const oldCwd = process.cwd();
  try {
    return withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], () => {
      const configured = 'matos-custom';
      writeFileSync(join(dir, configured), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, configured), 0o755);
      process.chdir(dir);
      process.env.PATH = '';
      process.env.OD_AGENT_HOME = dir;

      const resolved = resolveAgentExecutable(
        minimalAgentDef({ id: 'matos', bin: 'matos' }),
        { MATOS_BIN: configured },
      );

      assert.equal(resolved, null);
    });
  } finally {
    process.chdir(oldCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentExecutable ignores configured binary overrides that are not executable files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-agent-bin-invalid-'));
  try {
    return withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], () => {
      const directoryOverride = join(dir, 'as-directory');
      mkdirSync(directoryOverride);
      const fileOverride = join(dir, 'not-executable');
      writeFileSync(fileOverride, '#!/bin/sh\nexit 0\n');
      if (process.platform !== 'win32') chmodSync(fileOverride, 0o644);
      process.env.PATH = '';
      process.env.OD_AGENT_HOME = dir;

      assert.equal(
        resolveAgentExecutable(minimalAgentDef({ id: 'matos', bin: 'matos' }), { MATOS_BIN: directoryOverride }),
        null,
      );
      if (process.platform !== 'win32') {
        assert.equal(
          resolveAgentExecutable(minimalAgentDef({ id: 'matos', bin: 'matos' }), { MATOS_BIN: fileOverride }),
          null,
        );
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentExecutable ignores Windows MATOS_BIN overrides without executable PATHEXT extension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-agent-bin-win-invalid-'));
  try {
    return withEnvSnapshot(['PATH', 'PATHEXT', 'OD_AGENT_HOME'], () => {
      const invalidOverride = join(dir, 'matos-custom.txt');
      const fallback = join(dir, 'matos.CMD');
      writeFileSync(invalidOverride, '@echo off\r\nexit /b 0\r\n');
      writeFileSync(fallback, '@echo off\r\nexit /b 0\r\n');
      process.env.PATH = dir;
      process.env.PATHEXT = '.EXE;.CMD;.BAT';
      process.env.OD_AGENT_HOME = dir;

      const resolved = withPlatform('win32', () =>
        resolveAgentExecutable(
          minimalAgentDef({ id: 'matos', bin: 'matos' }),
          { MATOS_BIN: invalidOverride },
        ),
      );

      assert.equal(resolved, fallback);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentExecutable accepts Windows MATOS_BIN overrides with executable PATHEXT extension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-agent-bin-win-valid-'));
  try {
    return withEnvSnapshot(['PATH', 'PATHEXT', 'OD_AGENT_HOME'], () => {
      const configured = join(dir, 'matos-custom.CMD');
      writeFileSync(configured, '@echo off\r\nexit /b 0\r\n');
      process.env.PATH = '';
      process.env.PATHEXT = '.EXE;.CMD;.BAT';
      process.env.OD_AGENT_HOME = dir;

      const resolved = withPlatform('win32', () =>
        resolveAgentExecutable(
          minimalAgentDef({ id: 'matos', bin: 'matos' }),
          { MATOS_BIN: configured },
        ),
      );

      assert.equal(resolved, configured);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// agy's print mode (`-p -`) exits with code 0 but emits one of these
// shapes when the keyring entry is missing or expired. Without the
// matcher, the daemon treats this as a successful turn and shows the
// raw OAuth URL as the agent's "reply" — but the user has no way to
// complete OAuth from inside chat (agy `-p` has no input field to
// paste the auth code into). The matcher converts each shape into
// AGENT_AUTH_REQUIRED with actionable guidance.



test('spawnEnvForAgent preserves configured DeepSeek credentials', () => {
  const env = spawnEnvForAgent('matos', {
    DEEPSEEK_API_KEY: 'test-provider-key',
    DEEPSEEK_BASE_URL: 'https://models.example/anthropic',
    PATH: '/usr/bin',
  });

  assert.equal(env.DEEPSEEK_API_KEY, 'test-provider-key');
  assert.equal(env.DEEPSEEK_BASE_URL, 'https://models.example/anthropic');
});

test('spawnEnvForAgent does not mutate the input env', () => {
  const original = { DEEPSEEK_API_KEY: 'test-provider-key', PATH: '/usr/bin' };
  const env = spawnEnvForAgent('matos', original);

  assert.equal(original.DEEPSEEK_API_KEY, 'test-provider-key');
  assert.notEqual(env, original);
});
