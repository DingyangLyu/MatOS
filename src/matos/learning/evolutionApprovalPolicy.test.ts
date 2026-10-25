import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  matOSEvolutionApprovalPolicyPath,
  resolveMatOSEvolutionApprovalMode,
  writeMatOSEvolutionApprovalPolicy,
} from './evolutionApprovalPolicy.js'

// Blank every variable the resolver reads so the host shell cannot leak in.
const CLEAN_ENV = {
  MATOS_EVOLUTION_APPROVAL_MODE: '',
  MATOS_STANDALONE: '',
  MATOS_STANDALONE_WORKSPACE: '',
  MATOS_ASSETS_CWD: '',
}

describe('MatOS evolution approval policy', () => {
  test('defaults to manual for the standalone edition and auto otherwise', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-evolution-policy-default-'))
    expect(await resolveMatOSEvolutionApprovalMode({ cwd, env: CLEAN_ENV })).toMatchObject({
      mode: 'auto',
      source: 'default',
    })
    expect(
      await resolveMatOSEvolutionApprovalMode({
        cwd,
        env: { ...CLEAN_ENV, MATOS_STANDALONE: '1' },
      }),
    ).toMatchObject({ mode: 'manual', source: 'default' })
  })

  test('a written policy wins over the default and the env override wins over both', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-evolution-policy-write-'))
    const env = { ...CLEAN_ENV, MATOS_STANDALONE: '1' }
    await writeMatOSEvolutionApprovalPolicy({ cwd, env, mode: 'off' })

    const path = join(cwd, '.matos', 'evolution', 'policy.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 1, mode: 'off' })
    expect(await resolveMatOSEvolutionApprovalMode({ cwd, env })).toMatchObject({
      mode: 'off',
      source: 'policy-file',
      policyPath: path,
    })
    expect(
      await resolveMatOSEvolutionApprovalMode({
        cwd,
        env: { ...env, MATOS_EVOLUTION_APPROVAL_MODE: 'auto' },
      }),
    ).toMatchObject({ mode: 'auto', source: 'env' })
  })

  test('the standalone workspace holds the policy for every project', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'matos-evolution-policy-workspace-'))
    const project = await mkdtemp(join(tmpdir(), 'matos-evolution-policy-project-'))
    const env = {
      ...CLEAN_ENV,
      MATOS_STANDALONE_WORKSPACE: workspace,
      MATOS_ASSETS_CWD: project,
    }
    expect(matOSEvolutionApprovalPolicyPath({ cwd: project, env })).toBe(
      join(workspace, '.matos', 'evolution', 'policy.json'),
    )
    expect(
      matOSEvolutionApprovalPolicyPath({ cwd: project, env: { ...CLEAN_ENV, MATOS_ASSETS_CWD: project } }),
    ).toBe(join(project, '.matos', 'evolution', 'policy.json'))
  })

  test('an unreadable or unknown policy falls back to the default', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-evolution-policy-invalid-'))
    await mkdir(join(cwd, '.matos', 'evolution'), { recursive: true })
    await writeFile(join(cwd, '.matos', 'evolution', 'policy.json'), '{"mode":"sometimes"}')
    expect(await resolveMatOSEvolutionApprovalMode({ cwd, env: CLEAN_ENV })).toMatchObject({
      mode: 'auto',
      source: 'default',
    })
    await expect(
      writeMatOSEvolutionApprovalPolicy({ cwd, env: CLEAN_ENV, mode: 'sometimes' as never }),
    ).rejects.toThrow('Unknown evolution approval mode')
  })
})
