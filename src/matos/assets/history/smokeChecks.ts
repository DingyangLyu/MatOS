import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { relative, resolve } from 'node:path'
import { buildMatOSAssetRegistry } from '../registry.js'
import { composeMatOSRoleRuntime } from '../runtimeComposition.js'
import { loadMatOSToolDefinitions } from '../../tools/matosToolRunner.js'
import { parseWorkflowDefinition } from '../../workflows/schema.js'
import { validateWorkflowDefinition } from '../../workflows/validateWorkflow.js'
import type { MatOSWorkflowValidationError } from '../../workflows/types.js'
import type { MatOSAsset } from '../types.js'

/**
 * Gate 1 smoke checks: asset-type-specific load/compose/materialize probes
 * that run on top of structural registry validation when a validation caller
 * requests the `smoke` or `full` gate profile.
 *
 * Design constraints:
 * - Deterministic, local, side-effect-free: no LLM calls, no network, no
 *   process spawns, no writes. `exec`-style replay of tool entrypoints is
 *   intentionally out of scope for Gate 1.
 * - Differential-friendly: errors reuse the asset-validation error shape
 *   (code/assetKey/manifestPath/message) so existing baseline fingerprint
 *   filtering applies unchanged, and messages avoid volatile temp-root paths.
 * - Never throws: an internal smoke-infrastructure failure becomes one error
 *   entry instead of breaking the surrounding validation call.
 */

export type MatOSAssetSmokeCheckErrorCode =
  | 'smoke_workflow_invalid'
  | 'smoke_workflow_unparseable'
  | 'smoke_role_composition'
  | 'smoke_tool_load'
  | 'smoke_tool_entry_missing'
  | 'smoke_tool_prompt_missing'
  | 'smoke_tool_builtin_pack_empty'
  | 'smoke_skill_entry_unreadable'
  | 'smoke_mcp_config_invalid'
  | 'smoke_entry_unreadable'
  | 'smoke_internal'

export type MatOSAssetSmokeCheckError = {
  code: MatOSAssetSmokeCheckErrorCode
  assetId?: string
  assetKey?: string
  manifestPath: string
  message: string
}

export type MatOSAssetWorkflowSmokeRecord = {
  assetKey: string
  ok: boolean
  errors: MatOSWorkflowValidationError[]
}

export type MatOSAssetSmokeCheckSummary = {
  gateProfile: 'smoke' | 'full'
  checkedAssets: number
  checkedByType: Record<string, number>
  errorCount: number
}

export type MatOSAssetSmokeCheckResult = {
  errors: MatOSAssetSmokeCheckError[]
  workflowValidation: MatOSAssetWorkflowSmokeRecord[]
  summary: MatOSAssetSmokeCheckSummary
}

const SMOKE_CHECKED_TYPES = new Set([
  'workflow',
  'role',
  'skill',
  'tool',
  'mcp',
  'knowledge',
  'data',
])

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Strip the volatile validation root from messages so fingerprints stay stable. */
function scrubRoot(message: string, root: string): string {
  return message.split(root).join('<validation-root>')
}

function smokeError(input: {
  code: MatOSAssetSmokeCheckErrorCode
  asset?: MatOSAsset
  root: string
  message: string
}): MatOSAssetSmokeCheckError {
  return {
    code: input.code,
    ...(input.asset?.id ? { assetId: input.asset.id } : {}),
    ...(input.asset?.canonicalKey ? { assetKey: input.asset.canonicalKey } : {}),
    manifestPath: input.asset
      ? relative(input.root, input.asset.manifestPath) || input.asset.manifestPath
      : '',
    message: scrubRoot(input.message, input.root),
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      return false
    }
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function checkWorkflowAsset(input: {
  asset: MatOSAsset
  root: string
  errors: MatOSAssetSmokeCheckError[]
  workflowValidation: MatOSAssetWorkflowSmokeRecord[]
}): Promise<void> {
  const { asset, root, errors, workflowValidation } = input
  const entryPath = asset.entryAbsolutePath
  if (!entryPath) {
    // Structural validation already reports missing entries.
    return
  }
  let definitionContent: string
  try {
    definitionContent = await readFile(entryPath, 'utf8')
  } catch (error) {
    errors.push(
      smokeError({
        code: 'smoke_workflow_unparseable',
        asset,
        root,
        message: `Workflow entry is unreadable: ${errorMessage(error)}`,
      }),
    )
    return
  }
  try {
    const definition = parseWorkflowDefinition(definitionContent, {
      sourcePath: entryPath,
    })
    const result = validateWorkflowDefinition(definition)
    workflowValidation.push({
      assetKey: asset.canonicalKey,
      ok: result.ok,
      errors: result.errors,
    })
    for (const error of result.errors) {
      errors.push(
        smokeError({
          code: 'smoke_workflow_invalid',
          asset,
          root,
          message: `Workflow validation ${error.code}${
            error.nodeId ? ` (node ${error.nodeId})` : ''
          }${error.path ? ` (${error.path})` : ''}: ${error.message}`,
        }),
      )
    }
  } catch (error) {
    workflowValidation.push({
      assetKey: asset.canonicalKey,
      ok: false,
      errors: [
        {
          code: 'missing_field',
          message: scrubRoot(errorMessage(error), root),
        },
      ],
    })
    errors.push(
      smokeError({
        code: 'smoke_workflow_unparseable',
        asset,
        root,
        message: `Workflow definition failed to parse: ${errorMessage(error)}`,
      }),
    )
  }
}

async function checkRoleAsset(input: {
  asset: MatOSAsset
  root: string
  registry: ReturnType<typeof buildMatOSAssetRegistry>
  errors: MatOSAssetSmokeCheckError[]
}): Promise<void> {
  const { asset, root, registry, errors } = input
  try {
    await composeMatOSRoleRuntime(registry, asset.canonicalKey, {
      projectCwd: root,
    })
  } catch (error) {
    errors.push(
      smokeError({
        code: 'smoke_role_composition',
        asset,
        root,
        message: `Role runtime composition failed: ${errorMessage(error)}`,
      }),
    )
  }
}

async function checkSkillAsset(input: {
  asset: MatOSAsset
  root: string
  errors: MatOSAssetSmokeCheckError[]
}): Promise<void> {
  const { asset, root, errors } = input
  const entryPath = asset.entryAbsolutePath
  if (!entryPath) {
    return
  }
  try {
    const content = await readFile(entryPath, 'utf8')
    if (!content.trim()) {
      errors.push(
        smokeError({
          code: 'smoke_skill_entry_unreadable',
          asset,
          root,
          message: 'Skill entry file is empty',
        }),
      )
    }
  } catch (error) {
    errors.push(
      smokeError({
        code: 'smoke_skill_entry_unreadable',
        asset,
        root,
        message: `Skill entry is unreadable: ${errorMessage(error)}`,
      }),
    )
  }
}

async function checkToolAsset(input: {
  asset: MatOSAsset
  root: string
  errors: MatOSAssetSmokeCheckError[]
}): Promise<void> {
  const { asset, root, errors } = input
  const kind = optionalString(
    (asset.metadata as Record<string, unknown>).kind,
  )

  if (kind === 'builtin-pack') {
    if (stringArray(asset.metadata.builtinTools).length === 0) {
      errors.push(
        smokeError({
          code: 'smoke_tool_builtin_pack_empty',
          asset,
          root,
          message: 'Builtin-pack tool asset declares no builtinTools',
        }),
      )
    }
    return
  }

  if (kind !== 'external-tool') {
    // Plain binding tools map to built-in/MCP tool names; nothing to load.
    return
  }

  let definitions: Awaited<ReturnType<typeof loadMatOSToolDefinitions>>
  try {
    definitions = await loadMatOSToolDefinitions([asset.manifestDir])
  } catch (error) {
    errors.push(
      smokeError({
        code: 'smoke_tool_load',
        asset,
        root,
        message: `Tool definition failed to load: ${errorMessage(error)}`,
      }),
    )
    return
  }
  for (const definition of definitions) {
    if (!(await isReadableFile(definition.entry))) {
      errors.push(
        smokeError({
          code: 'smoke_tool_entry_missing',
          asset,
          root,
          message: `Tool executor entry is missing or unreadable: ${relative(
            asset.manifestDir,
            definition.entry,
          )}`,
        }),
      )
    }
  }
  const promptPath = optionalString(
    (asset.metadata as Record<string, unknown>).promptPath,
  )
  if (promptPath && !(await isReadableFile(resolve(asset.manifestDir, promptPath)))) {
    errors.push(
      smokeError({
        code: 'smoke_tool_prompt_missing',
        asset,
        root,
        message: `Tool prompt file is missing or unreadable: ${promptPath}`,
      }),
    )
  }
}

async function checkMcpAsset(input: {
  asset: MatOSAsset
  root: string
  errors: MatOSAssetSmokeCheckError[]
}): Promise<void> {
  const { asset, root, errors } = input
  const configPath = asset.entryAbsolutePath ?? asset.absolutePath
  if (!configPath || !configPath.endsWith('.json')) {
    return
  }
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      mcpServers?: unknown
    }
    if (
      !parsed.mcpServers ||
      typeof parsed.mcpServers !== 'object' ||
      Array.isArray(parsed.mcpServers) ||
      Object.keys(parsed.mcpServers as Record<string, unknown>).length === 0
    ) {
      errors.push(
        smokeError({
          code: 'smoke_mcp_config_invalid',
          asset,
          root,
          message: 'MCP config declares no mcpServers entries',
        }),
      )
    }
  } catch (error) {
    errors.push(
      smokeError({
        code: 'smoke_mcp_config_invalid',
        asset,
        root,
        message: `MCP config failed to parse: ${errorMessage(error)}`,
      }),
    )
  }
}

async function checkEntryReadability(input: {
  asset: MatOSAsset
  root: string
  errors: MatOSAssetSmokeCheckError[]
}): Promise<void> {
  const { asset, root, errors } = input
  const entryPath = asset.entryAbsolutePath
  if (!entryPath) {
    return
  }
  if (!(await isReadableFile(entryPath))) {
    errors.push(
      smokeError({
        code: 'smoke_entry_unreadable',
        asset,
        root,
        message: `${asset.type} entry is missing or unreadable: ${
          asset.entryRelativePath ?? relative(root, entryPath)
        }`,
      }),
    )
  }
}

export async function runMatOSAssetHistorySmokeChecks(input: {
  root: string
  assets: MatOSAsset[]
  checkAssets?: MatOSAsset[]
  gateProfile: 'smoke' | 'full'
}): Promise<MatOSAssetSmokeCheckResult> {
  const errors: MatOSAssetSmokeCheckError[] = []
  const workflowValidation: MatOSAssetWorkflowSmokeRecord[] = []
  const checkedByType: Record<string, number> = {}
  let checkedAssets = 0

  try {
    const registry = buildMatOSAssetRegistry(input.assets)
    for (const asset of input.checkAssets ?? input.assets) {
      if (!SMOKE_CHECKED_TYPES.has(asset.type)) {
        continue
      }
      checkedAssets += 1
      checkedByType[asset.type] = (checkedByType[asset.type] ?? 0) + 1
      try {
        switch (asset.type) {
          case 'workflow':
            await checkWorkflowAsset({
              asset,
              root: input.root,
              errors,
              workflowValidation,
            })
            break
          case 'role':
            await checkRoleAsset({ asset, root: input.root, registry, errors })
            break
          case 'skill':
            await checkSkillAsset({ asset, root: input.root, errors })
            break
          case 'tool':
            await checkToolAsset({ asset, root: input.root, errors })
            break
          case 'mcp':
            await checkMcpAsset({ asset, root: input.root, errors })
            break
          case 'knowledge':
          case 'data':
            await checkEntryReadability({ asset, root: input.root, errors })
            break
        }
      } catch (error) {
        errors.push(
          smokeError({
            code: 'smoke_internal',
            asset,
            root: input.root,
            message: `Smoke check failed unexpectedly: ${errorMessage(error)}`,
          }),
        )
      }
    }
  } catch (error) {
    errors.push({
      code: 'smoke_internal',
      manifestPath: '',
      message: scrubRoot(
        `Smoke check infrastructure failed: ${errorMessage(error)}`,
        input.root,
      ),
    })
  }

  return {
    errors,
    workflowValidation,
    summary: {
      gateProfile: input.gateProfile,
      checkedAssets,
      checkedByType,
      errorCount: errors.length,
    },
  }
}
