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

import { matOSGiteaEnvValue } from './giteaOperatorEnv.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

const LOCAL_GIT_NO_PROXY_HOSTS = [
  '127.0.0.1',
  'localhost',
  '::1',
  'matos-gitea',
] as const

function gitBasicAuthUsername(input: {
  username?: string
  env: NodeJS.ProcessEnv
}): string {
  return (
    input.username?.trim() ||
    matOSGiteaEnvValue(
      [
        'MATOS_GITEA_GIT_USERNAME',
        'MATOS_GITEA_ADMIN_USER',
        'MATOS_GITEA_USERNAME',
      ],
      input.env,
    ) ||
    'matos-admin'
  )
}

function gitBasicAuthHeader(input: {
  username?: string
  token: string
  env: NodeJS.ProcessEnv
}): string {
  const username = gitBasicAuthUsername(input)
  const encoded = Buffer.from(`${username}:${input.token}`, 'utf8').toString(
    'base64',
  )
  return `Authorization: Basic ${encoded}`
}

function appendNoProxyHosts(value: string | undefined): string {
  const hosts = new Set(
    (value ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  )
  for (const host of LOCAL_GIT_NO_PROXY_HOSTS) {
    hosts.add(host)
  }
  return [...hosts].join(',')
}

export function matOSGitProcessEnv(input: {
  token?: string
  repo?: string
  username?: string
  env?: NodeJS.ProcessEnv
} = {}): NodeJS.ProcessEnv {
  const base = input.env ?? process.env
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  }
  // Local Gitea-backed asset repos use 127.0.0.1 on the host and matos-gitea
  // inside containers. Global proxy variables can otherwise send localhost Git
  // traffic to an HTTP proxy and make asset materialization hang.
  env.NO_PROXY = appendNoProxyHosts(base.NO_PROXY ?? base.no_proxy)
  env.no_proxy = appendNoProxyHosts(base.no_proxy ?? base.NO_PROXY)

  // Child Git commands must not inherit another operation's authorization.
  const retained: [string, string][] = []
  const count = Number(base.GIT_CONFIG_COUNT ?? 0)
  if (Number.isSafeInteger(count) && count >= 0 && count <= 1024) {
    for (let i = 0; i < count; i++) {
      const key = base[`GIT_CONFIG_KEY_${i}`]
      const value = base[`GIT_CONFIG_VALUE_${i}`]
      if (key && value !== undefined && !/^http(?:\..*)?\.extraheader$/i.test(key)) retained.push([key, value])
    }
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key]
  }

  const token = input.repo !== undefined && !/^https?:\/\//i.test(input.repo) ? undefined : input.token?.trim()
  if (token) {
    env.GIT_CONFIG_COUNT = input.repo && /^https?:\/\//i.test(input.repo) ? '2' : '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    const header = gitBasicAuthHeader({
      token,
      username: input.username,
      env: base,
    })
    env.GIT_CONFIG_VALUE_0 = env.GIT_CONFIG_COUNT === '2' ? '' : header
    if (env.GIT_CONFIG_COUNT === '2') {
      const url = new URL(input.repo!)
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      env.GIT_CONFIG_KEY_1 = `http.${url.toString()}.extraHeader`
      env.GIT_CONFIG_VALUE_1 = header
    }
  }
  const offset = Number(env.GIT_CONFIG_COUNT ?? 0)
  for (const [i, [key, value]] of retained.entries()) {
    env[`GIT_CONFIG_KEY_${offset + i}`] = key
    env[`GIT_CONFIG_VALUE_${offset + i}`] = value
  }
  if (retained.length) env.GIT_CONFIG_COUNT = String(offset + retained.length)
  return env
}

export async function matOSGitCheckoutProcessEnv(cwd: string, token?: string, safeArgs: string[] = []): Promise<NodeJS.ProcessEnv> {
  if (!token) return matOSGitProcessEnv()
  const result = await execFileAsync('git', [...safeArgs, 'config', '--get', 'remote.origin.url'], {
    cwd, env: matOSGitProcessEnv(), timeout: 5000,
  }).catch(() => ({ stdout: '' }))
  return matOSGitProcessEnv({ token, repo: String(result.stdout).trim() })
}
