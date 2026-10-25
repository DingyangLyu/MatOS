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

import { adaptMatOSPath } from '../assets/adaptPath.js'
import { writeJson, type MatOSAssetsIO, type ParsedArgs } from './assetsCliShared.js'

const USAGE =
  'Usage: matos assets adapt-path --path <file-or-directory> ' +
  '[--scope-ref user:<id>|team:<id>|project:<id>] [--id <asset-id>] ' +
  '[--name <name>] [--version <semver>] [--description <text>] ' +
  '[--reason <text>] [--replace] [--dry-run] [--json]\n'

export async function adaptPathAssetsCommand(
  io: MatOSAssetsIO,
  options: ParsedArgs,
): Promise<number> {
  const path = options.path?.trim() ?? options.positionals[0]?.trim()
  if (!path) {
    io.stderr(USAGE)
    return 1
  }
  const result = await adaptMatOSPath({
    cwd: io.cwd,
    path,
    scopeRef: options.scopeRef ?? options.rawScope,
    id: options.id,
    name: options.name,
    version: options.version,
    description: options.description,
    reason: options.reason,
    dryRun: options.dryRun,
    replace: options.replace,
    env: process.env,
  })
  if (options.json) {
    writeJson(io, result)
  } else if (result.ok) {
    const refs = Array.isArray(result.assets)
      ? result.assets.flatMap(asset =>
          asset && typeof asset === 'object' && 'ref' in asset && typeof asset.ref === 'string'
            ? [asset.ref]
            : [],
        )
      : []
    io.stdout(`${options.dryRun ? 'planned' : 'published'} ${refs.join(', ')}\n`)
  } else {
    io.stderr(`adapt-path: ${typeof result.error === 'string' ? result.error : 'failed'}\n`)
  }
  return result.ok ? 0 : 1
}
