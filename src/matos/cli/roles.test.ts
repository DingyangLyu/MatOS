import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runMatOSCli } from './main.js'
import { getMatOSConfigPath } from '../project.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-role-delegate-'))
  const plannerDir = join(root, '.matos', 'assets', 'roles', 'planner')
  const criticDir = join(root, '.matos', 'assets', 'roles', 'critic')
  const agentToolDir = join(root, '.matos', 'assets', 'tools', 'agent-orchestration')
  const knowledgeDir = join(root, '.matos', 'assets', 'knowledges', 'matbench')
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'relax')
  await mkdir(plannerDir, { recursive: true })
  await mkdir(criticDir, { recursive: true })
  await mkdir(agentToolDir, { recursive: true })
  await mkdir(knowledgeDir, { recursive: true })
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(agentToolDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'agent-orchestration',
    type: 'tool',
    name: 'Agent Orchestration',
    version: '1.0.0',
    runtime: {},
    metadata: {
      kind: 'builtin-pack',
      builtinTools: ['Agent'],
    },
  })
  await writeJson(join(knowledgeDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'matbench',
    type: 'knowledge',
    name: 'Matbench',
    version: '1.0.0',
    entry: 'README.md',
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'relax',
    type: 'workflow',
    name: 'Relax Workflow',
    version: '1.0.0',
  })
  await writeJson(join(plannerDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'planner',
    type: 'role',
    name: 'Planner',
    version: '1.0.0',
    entry: 'ROLE.md',
    dependencies: ['tool:agent-orchestration'],
    mounts: {
      tools: ['tool:agent-orchestration'],
    },
    runtime: {
      permissionMode: 'bypassPermissions',
    },
  })
  await writeJson(join(criticDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'critic',
    type: 'role',
    name: 'Critic',
    version: '1.0.0',
    entry: 'ROLE.md',
  })
  await Bun.write(join(plannerDir, 'ROLE.md'), 'You plan work.\n')
  await Bun.write(join(criticDir, 'ROLE.md'), 'You review plans.\n')
  await Bun.write(join(knowledgeDir, 'README.md'), 'Matbench details.\n')
  return root
}

describe('MatOS role delegation CLI', () => {
  test('attaches generic capabilities and patches role runtime through native manifests', async () => {
    const root = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSCli(
        ['roles', 'attach', 'planner', 'knowledge:matbench', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
          launchAgent: async () => 99,
        },
      ),
    ).toBe(0)
    const attachedKnowledge = JSON.parse(stdout.join('')) as {
      role: string
      asset: string
      reference: string
      mountGroup: string
      changed: boolean
    }
    expect(attachedKnowledge).toMatchObject({
      role: 'role:planner@1.0.0',
      asset: 'knowledge:matbench@1.0.0',
      reference: 'knowledge:matbench',
      mountGroup: 'knowledge',
      changed: true,
    })

    stdout.length = 0
    expect(
      await runMatOSCli(
        ['roles', 'attach', 'planner', 'workflow:relax@1.0.0', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
          launchAgent: async () => 99,
        },
      ),
    ).toBe(0)
    const attachedWorkflow = JSON.parse(stdout.join('')) as {
      reference: string
      mountGroup: string
    }
    expect(attachedWorkflow.reference).toBe('workflow:relax@1.0.0')
    expect(attachedWorkflow.mountGroup).toBe('workflows')

    stdout.length = 0
    expect(
      await runMatOSCli(
        [
          'roles',
          'runtime',
          'set',
          'planner',
          '--model',
          'deepseek-v4-flash',
          '--effort',
          'high',
          '--permission-mode',
          'default',
          '--max-turns',
          '5',
          '--json',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
          launchAgent: async () => 99,
        },
      ),
    ).toBe(0)
    const runtimeUpdate = JSON.parse(stdout.join('')) as {
      role: string
      runtime: Record<string, unknown>
    }
    expect(runtimeUpdate.role).toBe('role:planner@1.0.0')
    expect(runtimeUpdate.runtime).toMatchObject({
      model: 'deepseek-v4-flash',
      effort: 'high',
      permissionMode: 'default',
      maxTurns: 5,
    })

    const plannerManifest = JSON.parse(
      await readFile(
        join(root, '.matos', 'assets', 'roles', 'planner', 'asset.json'),
        'utf8',
      ),
    ) as {
      dependencies: string[]
      mounts: { knowledge: string[]; workflows: string[]; tools: string[] }
      runtime: Record<string, unknown>
    }
    expect(plannerManifest.dependencies).toContain('knowledge:matbench')
    expect(plannerManifest.dependencies).toContain('workflow:relax@1.0.0')
    expect(plannerManifest.mounts.knowledge).toEqual(['knowledge:matbench'])
    expect(plannerManifest.mounts.workflows).toEqual(['workflow:relax@1.0.0'])
    expect(plannerManifest.mounts.tools).toEqual(['tool:agent-orchestration'])
    expect(plannerManifest.runtime).toMatchObject({
      model: 'deepseek-v4-flash',
      effort: 'high',
      permissionMode: 'default',
      maxTurns: 5,
    })

    stdout.length = 0
    expect(
      await runMatOSCli(
        ['roles', 'detach', 'planner', 'knowledge:matbench', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
          launchAgent: async () => 99,
        },
      ),
    ).toBe(0)
    const detachedKnowledge = JSON.parse(stdout.join('')) as {
      reference: string
      mountGroup: string
      changed: boolean
    }
    expect(detachedKnowledge).toMatchObject({
      reference: 'knowledge:matbench',
      mountGroup: 'knowledge',
      changed: true,
    })
    const detachedManifest = JSON.parse(
      await readFile(
        join(root, '.matos', 'assets', 'roles', 'planner', 'asset.json'),
        'utf8',
      ),
    ) as {
      dependencies: string[]
      mounts: { knowledge?: string[]; workflows: string[] }
    }
    expect(detachedManifest.dependencies).not.toContain('knowledge:matbench')
    expect(detachedManifest.mounts.knowledge).toBeUndefined()
    expect(detachedManifest.mounts.workflows).toEqual(['workflow:relax@1.0.0'])
    expect(stderr.join('')).toBe('')
  })

  test('clears runtime overrides with empty values and drops the empty runtime block', async () => {
    const root = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      launchAgent: async () => 99,
    }

    expect(
      await runMatOSCli(
        [
          'roles', 'runtime', 'set', 'planner',
          '--model', 'deepseek-v4-flash',
          '--effort', 'high',
          '--permission-mode', 'plan',
          '--max-turns', '5',
          '--json',
        ],
        io,
      ),
    ).toBe(0)

    // Clear each override: empty string for the string fields, 0 for max-turns.
    stdout.length = 0
    expect(
      await runMatOSCli(
        [
          'roles', 'runtime', 'set', 'planner',
          '--model', '',
          '--effort', '',
          '--permission-mode', '',
          '--max-turns', '0',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const cleared = JSON.parse(stdout.join('')) as {
      changed: boolean
      runtime: Record<string, unknown>
    }
    expect(cleared.changed).toBe(true)
    expect(cleared.runtime).toEqual({})

    const manifest = JSON.parse(
      await readFile(
        join(root, '.matos', 'assets', 'roles', 'planner', 'asset.json'),
        'utf8',
      ),
    ) as { runtime?: Record<string, unknown> }
    expect(manifest.runtime).toBeUndefined()
    expect(stderr.join('')).toBe('')
  })

  test('adds, lists, and removes explicit role delegation edges', async () => {
    const root = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSCli(['roles', 'delegate', 'add', 'planner', 'critic', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        launchAgent: async () => 99,
      }),
    ).toBe(0)

    const added = JSON.parse(stdout.join('')) as {
      edge: { from: string; to: string; reference: string }
    }
    expect(added.edge).toEqual({
      from: 'role:planner@1.0.0',
      to: 'role:critic@1.0.0',
      reference: 'role:critic',
    })
    const plannerManifest = JSON.parse(
      await readFile(
        join(root, '.matos', 'assets', 'roles', 'planner', 'asset.json'),
        'utf8',
      ),
    ) as { dependencies: string[]; mounts: { roles: string[] } }
    expect(plannerManifest.dependencies).toContain('role:critic')
    expect(plannerManifest.mounts.roles).toEqual(['role:critic'])

    stdout.length = 0
    expect(
      await runMatOSCli(['roles', 'delegate', 'list', 'planner', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        launchAgent: async () => 99,
      }),
    ).toBe(0)
    const listed = JSON.parse(stdout.join('')) as {
      delegations: Array<{ from: string; to: string; reference: string }>
    }
    expect(listed.delegations).toEqual([
      {
        from: 'role:planner@1.0.0',
        to: 'role:critic@1.0.0',
        reference: 'role:critic',
      },
    ])

    stdout.length = 0
    expect(
      await runMatOSCli(['roles', 'delegate', 'remove', 'planner', 'critic', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        launchAgent: async () => 99,
      }),
    ).toBe(0)
    const removedManifest = JSON.parse(
      await readFile(
        join(root, '.matos', 'assets', 'roles', 'planner', 'asset.json'),
        'utf8',
      ),
    ) as { dependencies: string[]; mounts: { roles?: string[] } }
    expect(removedManifest.dependencies).not.toContain('role:critic')
    expect(removedManifest.mounts.roles).toBeUndefined()
    expect(stderr.join('')).toBe('')
  })

  test('materializes delegated roles into the existing AgentTool runtime', async () => {
    const root = await fixture()
    const stdout: string[] = []
    let launchedArgs: string[] = []
    let launchedAgents: Record<string, { tools?: string[]; prompt?: string }> = {}

    expect(
      await runMatOSCli(['roles', 'delegate', 'add', 'planner', 'critic'], {
        cwd: root,
        stdout: text => stdout.push(text),
        launchAgent: async () => 99,
      }),
    ).toBe(0)

    expect(
      await runMatOSCli(['--role', 'planner'], {
        cwd: root,
        launchAgent: async args => {
          launchedArgs = args
          const agentsIndex = args.indexOf('--agents-file')
          expect(agentsIndex).toBeGreaterThan(-1)
          launchedAgents = JSON.parse(
            await readFile(args[agentsIndex + 1] ?? '', 'utf8'),
          ) as Record<string, { tools?: string[]; prompt?: string }>
          return 0
        },
      }),
    ).toBe(0)

    const agentsIndex = launchedArgs.indexOf('--agents-file')
    expect(agentsIndex).toBeGreaterThan(-1)
    expect(Object.keys(launchedAgents).sort()).toEqual(['critic', 'planner'])
    expect(launchedAgents.planner?.tools).toContain('Agent')
    expect(launchedAgents.critic?.prompt).toContain('You review plans.')
  })

  test('lists roles as JSON when --json is passed', async () => {
    const root = await fixture()
    const stdout: string[] = []

    expect(
      await runMatOSCli(['roles', 'list', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: () => {},
        launchAgent: async () => 99,
      }),
    ).toBe(0)

    const listed = JSON.parse(stdout.join('')) as {
      assets: Array<{ canonicalKey: string; type: string }>
    }
    expect(listed.assets.map(asset => asset.canonicalKey).sort()).toEqual([
      'role:critic@1.0.0',
      'role:planner@1.0.0',
    ])
    expect(listed.assets.every(asset => asset.type === 'role')).toBe(true)
  })
})
