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

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MatOSAsset } from './types.js'
import { toMatOSAssetKey } from './refs.js'

function runtimeAsset(input: {
  id: string
  name: string
  description: string
  runtime: Record<string, unknown>
  metadata?: Record<string, unknown>
}): MatOSAsset {
  const manifestDir = dirname(fileURLToPath(import.meta.url))
  const version = '1.0.0'
  return {
    id: input.id,
    type: 'runtime',
    name: input.name,
    version,
    description: input.description,
    canonicalKey: toMatOSAssetKey('runtime', input.id, version),
    relativePath: '.',
    absolutePath: manifestDir,
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath: join(manifestDir, `${input.id}.builtin-runtime.json`),
    manifestDir,
    source: 'pack',
    sourcePath: manifestDir,
    packId: 'matos-runtime-builtin',
    packName: 'MatOS Runtime Builtins',
    packVersion: version,
    tags: ['builtin', 'runtime'],
    permissions: {},
    dependencies: [],
    mounts: {},
    runtime: input.runtime,
    lifecycle: { status: 'enabled' },
    metadata: input.metadata ?? {},
  }
}

export function createBuiltinRuntimeAssets(): MatOSAsset[] {
  return [runtimeAsset({
    id: 'local', name: 'Local MatOS Runtime',
    description: 'Runs MatOS DSH on this host.',
    runtime: { engine: 'local', workdir: 'inherit' },
    metadata: { capabilities: ['matos-cli', 'dsh-agent-loop', 'asset-mcp', 'workflow-runtime'] },
  })]
}
