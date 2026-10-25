/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test } from 'bun:test'
import { matOSGitProcessEnv } from './gitProcessEnv.js'

describe('MatOS git process env', () => {
  test('forces local Gitea URLs to bypass global proxies', () => {
    const env = matOSGitProcessEnv({
      env: {
        http_proxy: 'http://127.0.0.1:7897',
        https_proxy: 'http://127.0.0.1:7897',
        NO_PROXY: 'example.com',
      } as NodeJS.ProcessEnv,
    })

    expect(env.http_proxy).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toContain('example.com')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.NO_PROXY).toContain('matos-gitea')
    expect(env.no_proxy).toContain('127.0.0.1')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(env.GIT_ASKPASS).toBe('')
  })

  test('uses Gitea-compatible basic auth for git HTTP tokens', () => {
    const env = matOSGitProcessEnv({
      token: 'token-123',
      env: {
        MATOS_GITEA_ADMIN_USER: 'matos-admin',
      } as NodeJS.ProcessEnv,
    })

    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader')
    expect(env.GIT_CONFIG_VALUE_0?.startsWith('Authorization: Basic ')).toBe(
      true,
    )
    const encoded = env.GIT_CONFIG_VALUE_0?.replace('Authorization: Basic ', '')
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toBe(
      'matos-admin:token-123',
    )
  })

  test('scopes HTTP authentication to the repository and clears inherited extra headers', () => {
    const env = matOSGitProcessEnv({ token: 'scoped-fixture', repo: 'https://git.example/matos-users/alice.git', env: {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: stale-fixture',
    } })
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    expect(env.GIT_CONFIG_KEY_1).toBe('http.https://git.example/matos-users/alice.git.extraHeader')
    expect(env.GIT_CONFIG_VALUE_1).toStartWith('Authorization: Basic ')
  })

  test('does not pass ambient authorization to tokenless/external Git operations', () => {
    const env = matOSGitProcessEnv({ repo: 'https://external.example/public.git', env: {
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: parent-fixture',
      GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '/safe/source',
      GIT_CONFIG_PARAMETERS: "'http.extraHeader=Authorization: parent-fixture'",
    } })
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('safe.directory')
    expect(env.GIT_CONFIG_VALUE_0).toBe('/safe/source')
    expect(JSON.stringify(env)).not.toContain('parent-fixture')
  })
})
