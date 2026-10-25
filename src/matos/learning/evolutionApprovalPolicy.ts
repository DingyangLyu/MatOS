import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * How far hidden self-evolution may go on its own.
 *
 * - off: no automatic self-evolution runs (explicit manual requests still
 *   produce proposals that wait for a human).
 * - manual: the pipeline runs every gate (validation, target governance,
 *   semantic judge) but stops at a proposal; a human approves or rejects it
 *   before any asset changes.
 * - auto: gate-passing edits are accepted and published immediately.
 */
export type MatOSEvolutionApprovalMode = 'off' | 'manual' | 'auto'

export const MATOS_EVOLUTION_APPROVAL_MODES: readonly MatOSEvolutionApprovalMode[] = [
  'off',
  'manual',
  'auto',
]

export type MatOSEvolutionApprovalPolicy = {
  schemaVersion: 1
  mode: MatOSEvolutionApprovalMode
  updatedAt?: string
}

export type MatOSEvolutionApprovalResolution = {
  mode: MatOSEvolutionApprovalMode
  source: 'env' | 'policy-file' | 'default'
  policyPath: string
}

type Env = Record<string, string | undefined>

export function isMatOSEvolutionApprovalMode(
  value: unknown,
): value is MatOSEvolutionApprovalMode {
  return (
    typeof value === 'string' &&
    (MATOS_EVOLUTION_APPROVAL_MODES as readonly string[]).includes(value)
  )
}

function envValue(env: Env, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

// The policy is per installation, not per project: project sessions run with
// MATOS_ASSETS_CWD pointing at the project, so the standalone workspace wins.
export function matOSEvolutionApprovalPolicyPath(input: {
  cwd: string
  env?: Env
}): string {
  const env = { ...process.env, ...input.env }
  const root =
    envValue(env, 'MATOS_STANDALONE_WORKSPACE') ??
    envValue(env, 'MATOS_ASSETS_CWD') ??
    input.cwd
  return join(resolve(root), '.matos', 'evolution', 'policy.json')
}

export function defaultMatOSEvolutionApprovalMode(env?: Env): MatOSEvolutionApprovalMode {
  const merged = { ...process.env, ...env }
  return envValue(merged, 'MATOS_STANDALONE') === '1' ? 'manual' : 'auto'
}

export async function readMatOSEvolutionApprovalPolicy(input: {
  cwd: string
  env?: Env
}): Promise<MatOSEvolutionApprovalPolicy | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(matOSEvolutionApprovalPolicyPath(input), 'utf8'),
    ) as Partial<MatOSEvolutionApprovalPolicy>
    if (!isMatOSEvolutionApprovalMode(raw.mode)) {
      return undefined
    }
    return {
      schemaVersion: 1,
      mode: raw.mode,
      ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
    }
  } catch {
    return undefined
  }
}

export async function resolveMatOSEvolutionApprovalMode(input: {
  cwd: string
  env?: Env
}): Promise<MatOSEvolutionApprovalResolution> {
  const policyPath = matOSEvolutionApprovalPolicyPath(input)
  const override = envValue(
    { ...process.env, ...input.env },
    'MATOS_EVOLUTION_APPROVAL_MODE',
  )
  if (isMatOSEvolutionApprovalMode(override)) {
    return { mode: override, source: 'env', policyPath }
  }
  const policy = await readMatOSEvolutionApprovalPolicy(input)
  if (policy) {
    return { mode: policy.mode, source: 'policy-file', policyPath }
  }
  return {
    mode: defaultMatOSEvolutionApprovalMode(input.env),
    source: 'default',
    policyPath,
  }
}

export async function writeMatOSEvolutionApprovalPolicy(input: {
  cwd: string
  env?: Env
  mode: MatOSEvolutionApprovalMode
}): Promise<MatOSEvolutionApprovalPolicy> {
  if (!isMatOSEvolutionApprovalMode(input.mode)) {
    throw new Error(
      `Unknown evolution approval mode: ${String(input.mode)} (expected ${MATOS_EVOLUTION_APPROVAL_MODES.join(', ')})`,
    )
  }
  const path = matOSEvolutionApprovalPolicyPath(input)
  const policy: MatOSEvolutionApprovalPolicy = {
    schemaVersion: 1,
    mode: input.mode,
    updatedAt: new Date().toISOString(),
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return policy
}
