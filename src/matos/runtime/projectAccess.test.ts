import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMatOSProjectMetadataAtomic } from '../projectMetadata.js'
import {
  applyMatOSProjectAccessPolicyArgs,
  assertMatOSProjectToolInputAllowed,
  materializeMatOSProjectAccessPolicy,
} from './projectAccess.js'

const roots: string[] = []

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-project-access-'))
  roots.push(root)
  await writeMatOSProjectMetadataAtomic(root, {
    schemaVersion: 1,
    revision: 1,
    id: 'project-access-test',
    name: 'Project access test',
    goal: 'Keep project collaboration scoped.',
    team: [
      {
        memberId: 'agent-compute',
        roleRef: 'role:compute@1.0.0',
        label: 'Compute',
      },
      {
        memberId: 'agent-academic',
        roleRef: 'role:academic@1.0.0',
        label: 'Academic',
      },
      {
        memberId: 'user-bob-example-com',
        kind: 'human',
        userId: 'user:bob-example-com',
        label: 'bob@example.com',
      },
    ],
    memberBriefs: {
      'role:compute': 'Own calculations.',
    },
  })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MatOS project member access policy', () => {
  test('fails closed for roles and member bindings outside the project roster', async () => {
    const root = await projectFixture()
    await expect(materializeMatOSProjectAccessPolicy({
      cwd: root,
      roleRef: 'role:workflow-builder',
    })).rejects.toThrow("role is not a member of project")
    await expect(materializeMatOSProjectAccessPolicy({
      cwd: root,
      roleRef: 'role:compute',
      memberId: 'agent-academic',
    })).rejects.toThrow('is not bound to role:compute')

    await writeMatOSProjectMetadataAtomic(root, {
      schemaVersion: 1,
      revision: 2,
      id: 'project-access-test',
      name: 'Project access test',
      team: [{ memberId: 'broken-without-role' }],
    })
    await expect(materializeMatOSProjectAccessPolicy({
      cwd: root,
      roleRef: 'role:compute',
    })).rejects.toThrow('Invalid MatOS project team member')
  })

  test('allows only the selected member private root and preserves unrelated settings', async () => {
    const root = await projectFixture()
    const academicPrivate = join(root, '.matos', 'private', 'agent-academic')
    const computePrivate = join(root, '.matos', 'private', 'agent-compute')
    await mkdir(academicPrivate, { recursive: true })
    const peerPrivateLink = join(root, 'peer-private-link')
    await symlink(academicPrivate, peerPrivateLink, 'dir')
    const policy = await materializeMatOSProjectAccessPolicy({
      cwd: root,
      roleRef: 'role:compute@1.0.0',
      explicitSettings: {
        env: { PROJECT_SETTING: 'kept' },
        sandbox: {
          enabled: false,
          filesystem: {
            allowRead: [
              root,
              academicPrivate,
              computePrivate,
              peerPrivateLink,
              join(root, 'references'),
            ],
            allowWrite: [academicPrivate],
          },
        },
      },
    })
    expect(policy?.memberId).toBe('agent-compute')
    expect(policy?.memberBrief).toBe('Own calculations.')
    expect((await stat(computePrivate)).isDirectory()).toBe(true)

    const settings = JSON.parse(await readFile(policy!.settingsPath, 'utf8')) as any
    expect(settings.env.PROJECT_SETTING).toBe('kept')
    expect(settings.sandbox.enabled).toBe(true)
    expect(settings.sandbox.failIfUnavailable).toBe(true)
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false)
    expect(settings.sandbox.filesystem.denyRead).toContain(join(root, '.matos'))
    expect(settings.sandbox.filesystem.allowRead).toContain(join(root, '.matos', 'assets'))
    expect(settings.sandbox.filesystem.allowRead).toContain(computePrivate)
    expect(settings.sandbox.filesystem.allowRead).not.toContain(root)
    expect(settings.sandbox.filesystem.allowRead).not.toContain(academicPrivate)
    expect(settings.sandbox.filesystem.allowRead).not.toContain(peerPrivateLink)
    expect(settings.sandbox.filesystem.allowRead).toContain(join(root, 'references'))
    expect(settings.sandbox.filesystem.denyWrite).toContain(academicPrivate)
    expect(settings.sandbox.filesystem.denyWrite).toContain(
      join(root, '.matos', 'private', 'user-bob-example-com'),
    )
    expect(settings.sandbox.filesystem.denyWrite).toContain(join(root, '.matos', 'workbench'))
    expect(settings.sandbox.filesystem.denyWrite).toContain(join(root, '.matos', 'evolution'))
    expect(settings.sandbox.filesystem.denyWrite).toContain(join(root, '.matos', 'asset-history.git'))
    expect(settings.sandbox.filesystem.denyWrite).toContain(join(root, '.matos', '.gitignore'))
    expect(settings.permissions.deny).toContain(
      `Read(//${academicPrivate.replace(/^\/+/, '')}/**)`,
    )
  })

  test('merges one explicit settings file and rejects duplicate overrides', async () => {
    const root = await projectFixture()
    const explicitPath = join(root, 'settings.json')
    await writeFile(explicitPath, JSON.stringify({ env: { FROM_FILE: 'yes' } }), 'utf8')
    const applied = await applyMatOSProjectAccessPolicyArgs({
      cwd: root,
      roleRef: 'role:compute',
      args: ['--settings', explicitPath, '--verbose'],
    })
    expect(applied.args[0]).toBe('--settings')
    expect(applied.args[1]).toBe(applied.policy?.settingsPath)
    expect(applied.args).toContain('--verbose')
    const merged = JSON.parse(await readFile(applied.policy!.settingsPath, 'utf8')) as any
    expect(merged.env.FROM_FILE).toBe('yes')

    await expect(applyMatOSProjectAccessPolicyArgs({
      cwd: root,
      roleRef: 'role:compute',
      args: ['--settings', explicitPath, `--settings=${explicitPath}`],
    })).rejects.toThrow('Only one --settings option')
  })

  test('discovers the project root from nested working directories', async () => {
    const root = await projectFixture()
    const nested = join(root, 'calculations', 'qe', 'scf')
    await mkdir(nested, { recursive: true })

    const policy = await materializeMatOSProjectAccessPolicy({
      cwd: nested,
      roleRef: 'role:compute',
    })

    expect(policy?.projectCwd).toBe(root)
    expect(policy?.memberPrivateRoot).toBe(
      join(root, '.matos', 'private', 'agent-compute'),
    )
    expect(policy?.settingsPath.startsWith(join(root, '.matos', 'runtime'))).toBe(true)
  })

  test('uses the workspace container boundary when nested sandboxing is unavailable', async () => {
    const root = await projectFixture()
    const policy = await materializeMatOSProjectAccessPolicy({
      cwd: root,
      roleRef: 'role:compute',
      nestedSandboxAvailable: false,
    })

    const settings = JSON.parse(await readFile(policy!.settingsPath, 'utf8')) as any
    expect(settings.sandbox.enabled).toBe(false)
    expect(settings.sandbox.failIfUnavailable).toBe(false)
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(true)
    expect(settings.permissions.deny).toContain(
      `Read(//${join(root, '.matos', 'private', 'agent-academic').replace(/^\/+/, '')}/**)`,
    )
  })

  test('blocks MatOS MCP arguments that reference peer-private or internal state', async () => {
    const root = await projectFixture()
    const env = {
      MATOS_PROJECT_CWD: root,
      MATOS_PROJECT_MEMBER_ID: 'agent-compute',
    }
    expect(() => assertMatOSProjectToolInputAllowed({
      path: join(root, '.matos', 'private', 'agent-compute', 'notes.md'),
    }, env)).not.toThrow()
    expect(() => assertMatOSProjectToolInputAllowed({
      nested: { command: `cat ${join(root, '.matos', 'private', 'agent-academic', 'notes.md')}` },
    }, env)).toThrow('may not access another member')
    expect(() => assertMatOSProjectToolInputAllowed({
      path: encodeURIComponent('.matos/private/agent-academic/notes.md'),
    }, env)).toThrow('may not access another member')
    expect(() => assertMatOSProjectToolInputAllowed({
      path: join(root, '.matos', 'project.json'),
    }, env)).toThrow('internal project state')
    expect(() => assertMatOSProjectToolInputAllowed({
      path: join(root, '.matos', 'evolution', 'hidden.jsonl'),
    }, env)).toThrow('internal project state')
    expect(() => assertMatOSProjectToolInputAllowed({
      path: '.matos%252fprivate%252fagent-academic%252fnotes.md',
    }, env)).toThrow('another member')
    expect(() => assertMatOSProjectToolInputAllowed({
      path: '.matos/private/agent-compute/../agent-academic/notes.md',
    }, env)).toThrow('another member')
    expect(() => assertMatOSProjectToolInputAllowed({
      path: join(root, '.matos', 'assets', 'knowledge', 'shared.md'),
    }, env)).not.toThrow()
  })
})

test('project access accepts a workspace stored under .matos while protecting its own internal paths', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'matos-nested-state-'))
  roots.push(outer)
  const project = join(outer, '.matos', 'state', 'projects', 'mine')
  await mkdir(project, { recursive: true })
  const env = { MATOS_PROJECT_CWD: project, MATOS_PROJECT_MEMBER_ID: 'agent-compute' }
  for (const path of [join(project, 'input.pdf'), join(project, '.matos/private/agent-compute/notes.md')]) {
    expect(() => assertMatOSProjectToolInputAllowed({ path }, env)).not.toThrow()
  }
  for (const path of [join(project, '.matos/project.json'), join(project, '.matos/private/peer/notes.md'),
    join(outer, '.matos/state/projects/mine-other/input.pdf')]) {
    expect(() => assertMatOSProjectToolInputAllowed({ path }, env)).toThrow('internal project state')
  }
})
