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

// `matos assets publish-data` — publish a document payload (scene JSON,
// config, notes) as a versioned project-local `data` asset.
//
// `register-data` covers "the payload lives somewhere else, register a
// reference"; this command covers the other everyday case UIs and agents
// hit: "here is a small document, store it as a managed asset". The
// virtual-lab sandbox uses it to save scenes (`--tag virtual-lab-scene`),
// mirroring how the workflow canvas publishes drafts into workflow assets.
// The CLI adapter only reads the entry payload (file or stdin) and formats
// output; manifest writing, duplicate refusal, validation, and rollback live
// in the `publishMatOSDataAsset` service.

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { publishMatOSDataAsset } from '../assets/publishDataAsset.js'
import { writeJson, type MatOSAssetsIO, type ParsedArgs } from './assetsCliShared.js'

const USAGE =
  'Usage: matos assets publish-data --id <id> --name <name> ' +
  '--entry-file <path|-> [--entry-name <file>] [--pack <pack-id>] ' +
  '[--tag <tag>]... [--description <text>] [--version <version>] ' +
  '[--overwrite] [--json]\n'

async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let content = ''
  for await (const chunk of process.stdin) {
    content += chunk
  }
  return content
}

async function readEntryContent(
  io: MatOSAssetsIO,
  entryFile: string,
): Promise<string> {
  if (entryFile === '-') {
    return io.stdin ? await io.stdin() : await readProcessStdin()
  }
  const path = isAbsolute(entryFile) ? entryFile : join(io.cwd, entryFile)
  return readFile(path, 'utf8')
}

export async function publishDataAssetCommand(
  io: MatOSAssetsIO,
  options: ParsedArgs,
): Promise<number> {
  const id = options.id?.trim()
  const name = options.name?.trim()
  const entryFile = options.entryFile?.trim()
  if (!id || !name || !entryFile) {
    io.stderr(USAGE)
    return 1
  }

  let entryContent: string
  try {
    entryContent = await readEntryContent(io, entryFile)
  } catch (error) {
    io.stderr(
      `publish-data: cannot read --entry-file ${entryFile}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return 1
  }

  const result = await publishMatOSDataAsset({
    cwd: io.cwd,
    id,
    name,
    entryContent,
    entryName: options.entryName,
    packId: options.pack,
    version: options.version,
    description: options.description,
    tags: options.tags,
    // `--replace` stays accepted as an alias for consistency with the other
    // asset commands (`register-data`, `deploy-tool`).
    overwrite: options.overwrite || options.replace,
  })

  // Explicit discriminant comparison: this repo compiles without
  // strictNullChecks, where `!result.ok` does not narrow the union.
  if (result.ok === false) {
    if (result.code === 'validation_failed' && options.json) {
      writeJson(io, {
        ok: false,
        rolledBack: result.rolledBack === true,
        errors: result.errors ?? [],
      })
    } else {
      io.stderr(`${result.message}\n`)
      for (const error of result.errors ?? []) {
        io.stderr(`${error.code}: ${error.message}\n`)
      }
    }
    return 1
  }

  if (options.json) {
    writeJson(io, result)
  } else {
    io.stdout(`published ${result.ref} (${result.manifestPath})\n`)
  }
  return 0
}
