import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindMatOSWorkbenchCreatedRole,
  listMatOSWorkbenchProjectTimeline,
  sendMatOSWorkbenchProjectMessage,
  syncMatOSWorkbenchProjectConversations,
  syncMatOSWorkbenchProjectGroup,
} from './projectGroups.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MatOS project group metadata sync', () => {
  test('normalizes UI display versions at the authority and preserves an explicit pin policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-selection-policy-'))
    roots.push(root)
    const base = { cwd: root, id: 'selection-policy', name: 'Selection policy' }
    const first = await syncMatOSWorkbenchProjectGroup({
      ...base, assetRefs: ['skill:procedure@0.1.0', 'skill:procedure@0.1.1'], expectedRevision: 0,
    })
    expect(first.project.assetRefs).toEqual(['skill:procedure'])
    const pinned = await syncMatOSWorkbenchProjectGroup({
      ...base, assetRefs: ['skill:procedure@0.1.0'], assetVersionPolicy: 'pinned', expectedRevision: 1,
    })
    expect(pinned.project.assetRefs).toEqual(['skill:procedure@0.1.0'])
    const resaved = await syncMatOSWorkbenchProjectGroup({ ...base, assetRefs: ['skill:procedure@0.1.0'] })
    expect(resaved.project.assetRefs).toEqual(['skill:procedure@0.1.0'])
    const following = await syncMatOSWorkbenchProjectGroup({ ...base, assetVersionPolicy: 'follow-accepted' })
    expect(following.project.assetRefs).toEqual(['skill:procedure'])
    const metadata = JSON.parse(await readFile(join(root, '.matos/project.json'), 'utf8'))
    expect(metadata.assetRefs).toEqual(['skill:procedure'])
  })

  test('accepts revision zero on first sync and sanitizes member profile records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-group-sync-'))
    roots.push(root)

    const result = await syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'research-project',
      name: 'Research Project',
      members: ['role:compute'],
      memberNames: {
        'role:compute': ' Compute Lead ',
        invalid: 42,
      } as unknown as Record<string, string>,
      memberBriefs: {
        'role:compute': ' Run shared calculations ',
        invalid: { nested: true },
      } as unknown as Record<string, string>,
      assetRefs: ['knowledge:shared-runbook', 'knowledge:shared-runbook'],
      expectedRevision: 0,
    })

    expect(result.changed).toBe(true)
    expect(result.project.profile.revision).toBe(1)
    expect(result.project.profile.memberNames).toEqual({
      'role:compute': 'Compute Lead',
    })
    expect(result.project.profile.memberBriefs).toEqual({
      'role:compute': 'Run shared calculations',
    })
    expect(result.project.assetRefs).toEqual(['knowledge:shared-runbook'])
    expect(result.project.members).toEqual([
      expect.objectContaining({
        memberId: 'agent-compute',
        displayName: 'Compute Lead',
        roleRef: expect.stringMatching(/^role:compute@/),
      }),
    ])

    const metadata = JSON.parse(
      await readFile(join(root, '.matos', 'project.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(metadata.revision).toBe(1)
    expect(metadata.assetRefs).toEqual(['knowledge:shared-runbook'])

    await expect(syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'research-project',
      name: 'Research Project',
      expectedRevision: 0,
    })).rejects.toThrow('expected 0, got 1')
  })

  test('rejects invalid expected revisions before creating project state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-group-sync-'))
    roots.push(root)

    await expect(syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'research-project',
      name: 'Research Project',
      expectedRevision: -1,
    })).rejects.toThrow('Invalid MatOS project metadata revision')
  })

  test('falls back to compute instead of failing when a requested role is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-role-fallback-'))
    roots.push(root)

    const result = await syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'fallback-project',
      name: 'Fallback Project',
      members: ['role:not-published'],
    })

    expect(result.changed).toBe(true)
    expect(result.project.members).toEqual([
      expect.objectContaining({
        memberId: 'agent-compute',
        roleRef: expect.stringMatching(/^role:compute@/),
      }),
    ])
    expect(result.project.profile.roleResolutionWarnings).toEqual([
      expect.objectContaining({
        code: 'role_asset_fallback',
        requestedRoleRef: 'role:not-published',
        fallbackRoleRef: expect.stringMatching(/^role:compute@/),
      }),
    ])

    const metadata = JSON.parse(
      await readFile(join(root, '.matos', 'project.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(metadata.roleResolutionWarnings).toEqual(result.project.profile.roleResolutionWarnings)
  })

  test('resolves an attached shared role from the recipient scope asset view', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'matos-project-shared-role-'))
    const scopeRoot = await mkdtemp(join(tmpdir(), 'matos-recipient-scope-role-'))
    roots.push(projectRoot, scopeRoot)
    const roleDir = join(
      scopeRoot,
      '.matos',
      'assets',
      'roles',
      'recipient-shared-agent',
    )
    await mkdir(roleDir, { recursive: true })
    await writeFile(join(scopeRoot, '.matos', 'matos.json'), JSON.stringify({
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: true,
    }))
    await writeFile(join(roleDir, 'asset.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'recipient-shared-agent',
      type: 'role',
      name: 'Recipient Shared Agent',
      version: '1.0.0',
      entry: 'ROLE.md',
      metadata: {
        scopeRef: 'user:recipient',
        overlayOf: 'role:recipient-shared-agent@1.0.0',
      },
    }))
    await writeFile(join(roleDir, 'ROLE.md'), '# Recipient Shared Agent\n')

    const roleRef = 'role:recipient-shared-agent@1.0.0'
    const result = await syncMatOSWorkbenchProjectGroup({
      cwd: projectRoot,
      env: { MATOS_ASSETS_CWD: scopeRoot },
      id: 'shared-role-project',
      name: 'Shared Role Project',
      members: [roleRef],
      assetRefs: [roleRef],
    })

    expect(result.project.members).toEqual([
      expect.objectContaining({
        memberId: 'agent-recipient-shared-agent',
        roleRef,
        displayName: 'Recipient Shared Agent',
      }),
    ])
    expect(result.project.profile.roleResolutionWarnings).toBeUndefined()
  })

  test('does not replace an unresolved attached role asset with Compute', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-required-role-'))
    roots.push(root)
    const roleRef = 'role:required-private-agent@1.0.0'

    await expect(syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'required-role-project',
      name: 'Required Role Project',
      members: [roleRef],
      assetRefs: [roleRef],
    })).rejects.toThrow(`MatOS role asset not found: ${roleRef}`)
  })

  test('preserves custom member identity and rejects duplicate role owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-group-members-'))
    roots.push(root)
    const synced = await syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'member-project',
      name: 'Member Project',
      team: [{
        memberId: 'compute-lead',
        roleRef: 'role:compute',
        label: 'Compute Lead',
        runtimeRef: 'runtime:code',
      }],
    })
    expect(synced.project.members[0]).toMatchObject({
      memberId: 'compute-lead',
      displayName: 'Compute Lead',
      roleRef: expect.stringMatching(/^role:compute@/),
      runtimeRef: 'runtime:code',
    })
    await expect(syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'member-project',
      name: 'Member Project',
      team: [
        { memberId: 'compute-a', roleRef: 'role:compute' },
        { memberId: 'compute-b', roleRef: 'role:compute' },
      ],
      expectedRevision: synced.project.profile.revision,
    })).rejects.toThrow('assigned to multiple members')
    await expect(syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'member-project',
      name: 'Member Project',
      team: [
        { memberId: 'shared-member', roleRef: 'role:compute' },
        { memberId: 'shared-member', roleRef: 'role:research-scientist' },
      ],
      expectedRevision: synced.project.profile.revision,
    })).rejects.toThrow('assigned to multiple roles')
  })

  test('sync preserves role-less human collaborators without role resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-human-members-'))
    roots.push(root)
    const synced = await syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'shared-project',
      name: 'Shared Project',
      team: [
        { memberId: 'agent-compute', roleRef: 'role:compute', kind: 'agent' },
        {
          memberId: 'user-bob',
          kind: 'human',
          userId: 'user:bob-test-local',
          label: 'bob@test.local',
        },
      ],
    })

    expect(synced.project.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: 'agent-compute',
        roleRef: expect.stringMatching(/^role:compute@/),
      }),
      expect.objectContaining({
        memberId: 'user-bob',
        kind: 'human',
        userId: 'user:bob-test-local',
      }),
    ]))
    const metadata = JSON.parse(
      await readFile(join(root, '.matos', 'project.json'), 'utf8'),
    ) as { team: Array<Record<string, unknown>> }
    expect(metadata.team).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: 'user-bob',
        kind: 'human',
        userId: 'user:bob-test-local',
      }),
    ]))
  })

  test('created Role replacement is atomic and cannot remove a human or missing member', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-role-bind-'))
    roots.push(root)
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(root, '.matos', 'matos.json'), JSON.stringify({
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    }))
    for (const id of ['compute', 'research-scientist']) {
      const roleDir = join(root, '.matos', 'assets', 'roles', id)
      await mkdir(roleDir, { recursive: true })
      await writeFile(join(roleDir, 'asset.json'), JSON.stringify({
        schemaVersion: 1, id, type: 'role', name: id, version: '1.0.0',
      }))
    }
    const synced = await syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'atomic-role-bind',
      name: 'Atomic Role Bind',
      team: [
        { memberId: 'agent-compute', roleRef: 'role:compute', kind: 'agent' },
        {
          memberId: 'user-bob',
          kind: 'human',
          userId: 'user:bob',
          label: 'Bob',
        },
      ],
    })
    const initialRevision = synced.project.profile.revision

    await expect(bindMatOSWorkbenchCreatedRole({
      cwd: root,
      assetCwd: root,
      projectId: 'atomic-role-bind',
      roleRef: 'role:research-scientist',
      mode: 'replace-current',
      currentMemberId: 'missing-current',
      currentRoleRef: 'role:compute',
    })).rejects.toThrow('was not found')
    await expect(bindMatOSWorkbenchCreatedRole({
      cwd: root,
      assetCwd: root,
      projectId: 'atomic-role-bind',
      roleRef: 'role:research-scientist',
      mode: 'replace-current',
      currentMemberId: 'user-bob',
      currentRoleRef: 'role:compute',
    })).rejects.toThrow('is not an agent')

    const unchanged = JSON.parse(
      await readFile(join(root, '.matos', 'project.json'), 'utf8'),
    ) as { revision: number; team: Array<Record<string, unknown>>; assetRefs?: string[] }
    expect(unchanged.revision).toBe(initialRevision)
    expect(unchanged.team.map(member => member.memberId)).toEqual([
      'agent-compute',
      'user-bob',
    ])
    expect(unchanged.assetRefs ?? []).toEqual([])

    const replaced = await bindMatOSWorkbenchCreatedRole({
      cwd: root,
      assetCwd: root,
      projectId: 'atomic-role-bind',
      roleRef: 'role:research-scientist',
      displayName: 'Research Scientist',
      mode: 'replace-current',
      currentMemberId: 'agent-compute',
      currentRoleRef: 'role:compute',
    })
    expect(replaced.changed).toBe(true)
    expect(replaced.removedCurrent).toMatchObject({
      memberId: 'agent-compute',
      roleRef: expect.stringMatching(/^role:compute@/),
    })
    expect(replaced.project.profile.revision).toBe(initialRevision + 1)
    expect(replaced.project.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: 'user-bob', kind: 'human' }),
      expect.objectContaining({
        memberId: 'agent-research-scientist',
        roleRef: expect.stringMatching(/^role:research-scientist@/),
      }),
    ]))
    expect(replaced.project.members.some(member => member.memberId === 'agent-compute')).toBe(false)
    expect(replaced.project.assetRefs).toEqual([
      'role:research-scientist',
    ])
  })

  test('preserves conversation bindings and rejects ambiguous or foreign rosters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-conversations-'))
    roots.push(root)
    await syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'conversation-project',
      name: 'Conversation Project',
      members: ['role:compute', 'role:research-scientist'],
    })
    const synced = await syncMatOSWorkbenchProjectConversations({
      cwd: root,
      conversations: [{
        id: 'group-main',
        title: null,
        roleRef: 'role:compute',
        memberRefs: ['role:compute', 'role:research-scientist'],
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:01:00.000Z',
      }],
    })
    expect(synced.conversations[0]).toMatchObject({
      id: 'group-main',
      title: 'group-main',
      roleRef: expect.stringMatching(/^role:compute@/),
      memberRefs: [
        expect.stringMatching(/^role:compute@/),
        expect.stringMatching(/^role:research-scientist@/),
      ],
    })
    const metadata = JSON.parse(
      await readFile(join(root, '.matos', 'project.json'), 'utf8'),
    ) as { revision: number; conversations: Array<{ title?: string | null }> }
    expect(metadata.conversations[0]?.title).toBeNull()
    const unchanged = await syncMatOSWorkbenchProjectConversations({
      cwd: root,
      expectedRevision: metadata.revision,
      conversations: [{
        id: 'group-main',
        title: null,
        roleRef: 'role:compute',
        memberRefs: ['role:compute', 'role:research-scientist'],
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:01:00.000Z',
      }],
    })
    expect(unchanged.changed).toBe(false)
    expect(JSON.parse(
      await readFile(join(root, '.matos', 'project.json'), 'utf8'),
    ).revision).toBe(metadata.revision)
    await expect(syncMatOSWorkbenchProjectConversations({
      cwd: root,
      expectedRevision: metadata.revision - 1,
      conversations: [{ id: 'stale-write', memberRefs: [] }],
    })).rejects.toThrow('metadata revision conflict')

    await expect(syncMatOSWorkbenchProjectConversations({
      cwd: root,
      conversations: [
        { id: 'duplicate', memberRefs: [] },
        { id: 'duplicate', memberRefs: [] },
      ],
    })).rejects.toThrow('Duplicate MatOS project conversation id')
    await expect(syncMatOSWorkbenchProjectConversations({
      cwd: root,
      conversations: [{ id: 'foreign', memberRefs: ['role:workflow-builder'] }],
    })).rejects.toThrow('conversation member is not in the project')
  })

  test('repairs only a torn timeline tail and rejects middle corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-project-group-events-'))
    roots.push(root)
    await syncMatOSWorkbenchProjectGroup({
      cwd: root,
      id: 'timeline-project',
      name: 'Timeline Project',
      members: ['role:compute'],
    })
    await sendMatOSWorkbenchProjectMessage({
      cwd: root,
      projectId: 'timeline-project',
      conversationId: 'main',
      senderKind: 'human',
      text: 'first',
      eventId: 'event-first',
    })
    const eventsPath = join(root, '.matos', 'workbench', 'project-events.jsonl')
    await writeFile(eventsPath, (await readFile(eventsPath, 'utf8')).trimEnd(), 'utf8')
    await sendMatOSWorkbenchProjectMessage({
      cwd: root,
      projectId: 'timeline-project',
      conversationId: 'main',
      senderKind: 'human',
      text: 'after valid unterminated tail',
      eventId: 'event-valid-tail',
    })
    await appendFile(eventsPath, '{"eventId":"torn"', 'utf8')
    await sendMatOSWorkbenchProjectMessage({
      cwd: root,
      projectId: 'timeline-project',
      conversationId: 'main',
      senderKind: 'human',
      text: 'second',
      eventId: 'event-second',
    })
    expect((await listMatOSWorkbenchProjectTimeline({
      cwd: root,
      projectId: 'timeline-project',
      conversationId: 'main',
    })).events.map(event => event.eventId)).toEqual([
      'event-first',
      'event-valid-tail',
      'event-second',
    ])

    const validLines = (await readFile(eventsPath, 'utf8')).trim().split('\n')
    await writeFile(eventsPath, `${validLines[0]}\n{broken}\n${validLines[1]}\n`, 'utf8')
    await expect(listMatOSWorkbenchProjectTimeline({
      cwd: root,
      projectId: 'timeline-project',
      conversationId: 'main',
    })).rejects.toThrow('Invalid MatOS project timeline')

    await writeFile(eventsPath, `${validLines.join('\n')}\n{complete-but-broken}\n`, 'utf8')
    await expect(listMatOSWorkbenchProjectTimeline({
      cwd: root,
      projectId: 'timeline-project',
      conversationId: 'main',
    })).rejects.toThrow('Invalid MatOS project timeline')
  })
})

test('conversation role rosters authorize their resolved members without admitting another role', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-conversation-role-roster-'))
  roots.push(root)
  await syncMatOSWorkbenchProjectGroup({
    cwd: root, id: 'role-roster', name: 'Role roster',
    members: ['role:compute', 'role:research-scientist'],
  })
  await syncMatOSWorkbenchProjectConversations({
    cwd: root,
    conversations: [
      { id: 'both', memberRefs: ['role:compute', 'role:research-scientist'] },
      { id: 'compute-only', memberRefs: ['role:compute'] },
    ],
  })
  await expect(sendMatOSWorkbenchProjectMessage({
    cwd: root, projectId: 'role-roster', conversationId: 'both',
    senderKind: 'agent', memberId: 'agent-research-scientist',
    roleRef: 'role:research-scientist', text: 'Research contribution',
  })).resolves.toBeDefined()
  await expect(sendMatOSWorkbenchProjectMessage({
    cwd: root, projectId: 'role-roster', conversationId: 'compute-only',
    senderKind: 'agent', memberId: 'agent-research-scientist',
    roleRef: 'role:research-scientist', text: 'Not authorized for this conversation',
  })).rejects.toThrow('does not allow member')
})
