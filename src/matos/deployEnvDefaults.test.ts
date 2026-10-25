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

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  loadMatOSDeployEnvDefaults,
  parseMatOSDeployEnvDefaults,
} from './deployEnvDefaults.js'

describe('MatOS deploy env defaults', () => {
  test('parses shell-style exported defaults without executing shell syntax', () => {
    const parsed = parseMatOSDeployEnvDefaults(`
      # comment
      export DEEPSEEK_BASE_URL="https://api.deepseek.com/anthropic"
      DEEPSEEK_API_KEY='secret#kept'
      MATOS_DSH_MODEL=deepseek-flash # comment
      ignored line
    `)

    expect(parsed.DEEPSEEK_BASE_URL).toBe(
      'https://api.deepseek.com/anthropic',
    )
    expect(parsed.DEEPSEEK_API_KEY).toBe('secret#kept')
    expect(parsed.MATOS_DSH_MODEL).toBe('deepseek-flash')
  })

  test('resolves exact aliases to an earlier deploy env value', () => {
    const parsed = parseMatOSDeployEnvDefaults(`
      export MATOS_DEEPSEEK_KEY='paid-deepseek-key'
      export DEEPSEEK_API_KEY="\${MATOS_DEEPSEEK_KEY}"
    `)

    expect(parsed.MATOS_DEEPSEEK_KEY).toBe('paid-deepseek-key')
    expect(parsed.DEEPSEEK_API_KEY).toBe('paid-deepseek-key')
  })

  test('loads missing deploy defaults without overriding explicit env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-deploy-env-defaults-'))
    const env: Record<string, string | undefined> = {
      MATOS_DSH_MODEL: 'already-selected-model',
    }
    await writeFile(
      join(root, '.env.deploy'),
      [
        'MATOS_DSH_MODEL=deepseek-pro',
        'DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic',
        'DEEPSEEK_API_KEY=secret-deepseek-key',
      ].join('\n'),
      'utf8',
    )

    const result = await loadMatOSDeployEnvDefaults({ cwd: root, env })

    expect(result.loaded).toBe(true)
    expect(result.appliedKeys).toEqual(['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY'])
    expect(env.MATOS_DSH_MODEL).toBe('already-selected-model')
    expect(env.DEEPSEEK_API_KEY).toBe('secret-deepseek-key')
  })
})
