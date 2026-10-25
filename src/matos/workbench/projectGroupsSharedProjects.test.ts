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

// Group-project mechanics under cross-user sharing: shared projects must be
// discoverable from the workbench catalog, human turns must carry the acting
// user's own member identity, timeline appends must stay fast and idempotent
// on long group chats, and removing a human member must warn that the mount
// grant survives until an operator unshare.

import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMatOSWorkbenchProjects } from './projectCatalog.js'
import {
  actMatOSWorkbenchProjectMember,
  listMatOSWorkbenchProjectTimeline,
  sendMatOSWorkbenchProjectMessage,
  showMatOSWorkbenchProjectGroup,
} from './projectGroups.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeSharedLayout() {
  // Mirrors the container layout: <base>/shared is the user's workspace cwd
  // and <base>/workspaces/<slug> is where cross-user shares mount.
  const base = await mkdtemp(join(tmpdir(), 'matos-shared-projects-'))
  roots.push(base)
  const shared = join(base, 'shared')
  await mkdir(shared, { recursive: true })
  const sharedProject = join(base, 'workspaces', 'co-dev-demo')
  await mkdir(join(sharedProject, '.matos'), { recursive: true })
  await writeFile(
    join(sharedProject, '.matos', 'project.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      id: 'co-dev-demo',
      name: 'Co-dev demo',
      team: [
        {
          memberId: 'agent-compute',
          kind: 'agent',
          roleRef: 'role:compute',
          label: 'Compute',
          source: 'explicit',
        },
        {
          memberId: 'user-alice',
          kind: 'human',
          userId: 'user:alice-test-local',
          label: 'alice@test.local',
          source: 'explicit',
        },
        {
          memberId: 'user-bob',
          kind: 'human',
          userId: 'user:bob-test-local',
          label: 'bob@test.local',
          source: 'explicit',
        },
      ],
    })}\n`,
    'utf8',
  )
  return { base, shared, sharedProject }
}

describe('MatOS group projects under cross-user sharing', () => {
  test('shared projects mounted beside the workspace dir appear in the catalog', async () => {
    const { shared } = await makeSharedLayout()
    const listed = await listMatOSWorkbenchProjects({ cwd: shared })
    const sharedEntry = listed.projects.find(project => project.id === 'co-dev-demo')
    expect(sharedEntry).toBeDefined()

    // And the group view resolves through the same selection path.
    const group = await showMatOSWorkbenchProjectGroup({
      cwd: shared,
      projectId: 'co-dev-demo',
    })
    expect(group.project.id).toBe('co-dev-demo')
    expect(group.members.map(member => member.memberId)).toEqual(
      expect.arrayContaining(['agent-compute', 'user-alice', 'user-bob']),
    )
  })

  test('human messages carry the acting user member identity in shared projects', async () => {
    const { shared } = await makeSharedLayout()

    // bob's runtime exports MATOS_SCOPE_ID=user:bob-test-local.
    const sent = await sendMatOSWorkbenchProjectMessage({
      cwd: shared,
      projectId: 'co-dev-demo',
      text: 'alice 看下这个结果',
      env: { MATOS_SCOPE_ID: 'user:bob-test-local' },
    })
    expect(sent.event.sender.kind).toBe('human')
    expect(sent.event.sender.memberId).toBe('user-bob')
    expect(sent.event.sender.id).toBe('user:bob-test-local')

    // alice's turn resolves to her own member.
    const fromAlice = await sendMatOSWorkbenchProjectMessage({
      cwd: shared,
      projectId: 'co-dev-demo',
      text: '收到',
      env: { MATOS_SCOPE_ID: 'user:alice-test-local' },
    })
    expect(fromAlice.event.sender.memberId).toBe('user-alice')

    // A caller cannot override the authenticated human identity.
    await expect(sendMatOSWorkbenchProjectMessage({
      cwd: shared,
      projectId: 'co-dev-demo',
      text: 'explicit identity',
      memberId: 'user-alice',
      senderId: 'custom-sender',
      env: { MATOS_SCOPE_ID: 'user:bob-test-local' },
    })).rejects.toThrow(/acting member user-bob/)

    // Without a matching human member (foreign scope), behavior stays legacy.
    const anonymous = await sendMatOSWorkbenchProjectMessage({
      cwd: shared,
      projectId: 'co-dev-demo',
      text: 'anonymous fallback',
      env: { MATOS_SCOPE_ID: 'user:carol-test-local' },
    })
    expect(anonymous.event.sender.memberId).toBeUndefined()
    expect(anonymous.event.sender.id).toBe('user')
  })

  test('timeline appends stay idempotent and repair torn tails on large logs', async () => {
    const { shared, sharedProject } = await makeSharedLayout()
    const eventLog = join(sharedProject, '.matos', 'workbench', 'project-events.jsonl')
    await mkdir(join(sharedProject, '.matos', 'workbench'), { recursive: true })

    // Grow the log beyond the 1MB append scan window with valid history.
    const lines: string[] = []
    for (let index = 0; index < 3000; index += 1) {
      lines.push(
        JSON.stringify({
          eventId: `evt-history-${index}`,
          createdAt: new Date(1700000000000 + index * 1000).toISOString(),
          projectId: 'co-dev-demo',
          conversationId: 'main',
          sender: { kind: 'human', id: 'user', memberId: 'user-alice' },
          eventType: 'message',
          text: `historic message ${index} ${'x'.repeat(400)}`,
          refs: {},
        }),
      )
    }
    await writeFile(eventLog, `${lines.join('\n')}\n`, 'utf8')
    expect((await stat(eventLog)).size).toBeGreaterThan(1024 * 1024)

    // A crash leaves a torn tail; the next append truncates it cleanly.
    await appendFile(eventLog, '{"eventId":"evt-torn', 'utf8')
    const sent = await sendMatOSWorkbenchProjectMessage({
      cwd: shared,
      projectId: 'co-dev-demo',
      text: 'new message after torn tail',
      env: { MATOS_SCOPE_ID: 'user:bob-test-local' },
    })
    const content = await readFile(eventLog, 'utf8')
    expect(content).not.toContain('evt-torn')
    expect(content.endsWith('\n')).toBe(true)
    const parsedLines = content.trim().split('\n')
    expect(parsedLines).toHaveLength(3001)
    expect(JSON.parse(parsedLines.at(-1)!)).toMatchObject({
      eventId: sent.event.eventId,
      text: 'new message after torn tail',
    })

    // Recent duplicate event ids stay idempotent within the scan window.
    const duplicate = await sendMatOSWorkbenchProjectMessage({
      cwd: shared,
      projectId: 'co-dev-demo',
      eventId: sent.event.eventId,
      createdAt: sent.event.createdAt,
      text: 'new message after torn tail',
      env: { MATOS_SCOPE_ID: 'user:bob-test-local' },
    })
    expect(duplicate.event.eventId).toBe(sent.event.eventId)
    const afterDuplicate = await readFile(eventLog, 'utf8')
    expect(afterDuplicate.trim().split('\n')).toHaveLength(3001)

    // The timeline list still reads the full history.
    const timeline = await listMatOSWorkbenchProjectTimeline({
      cwd: shared,
      projectId: 'co-dev-demo',
      conversationId: 'main',
      limit: 10,
      offset: 2995,
    })
    expect(timeline.summary.total).toBe(3001)
  })

  test('removing a human member warns that the mount grant needs an operator unshare', async () => {
    const { shared } = await makeSharedLayout()
    const removedHuman = await actMatOSWorkbenchProjectMember({
      cwd: shared,
      projectId: 'co-dev-demo',
      action: 'remove',
      memberId: 'user-bob',
    })
    expect(removedHuman.changed).toBe(true)
    expect(removedHuman.warning).toContain('matos gateway projects unshare')
    expect(removedHuman.warning).toContain('user:bob-test-local')

    const removedAgent = await actMatOSWorkbenchProjectMember({
      cwd: shared,
      projectId: 'co-dev-demo',
      action: 'remove',
      memberId: 'agent-compute',
    })
    expect(removedAgent.changed).toBe(true)
    expect(removedAgent.warning).toBeUndefined()
  })
})

test('disambiguates duplicate metadata ids across project folders', async () => {
  const { shared } = await makeSharedLayout()
  const duplicate = join(shared, 'second-copy')
  await mkdir(join(duplicate, '.matos'), { recursive: true })
  await writeFile(
    join(duplicate, '.matos', 'project.json'),
    JSON.stringify({ schemaVersion: 1, revision: 1, id: 'co-dev-demo', name: 'Second copy' }),
    'utf8',
  )
  const listed = await listMatOSWorkbenchProjects({ cwd: shared })
  const matches = listed.projects.filter(project =>
    project.name === 'Co-dev demo' || project.name === 'Second copy',
  )
  expect(matches).toHaveLength(2)
  expect(new Set(matches.map(project => project.id)).size).toBe(2)
  expect(matches.filter(project => project.id === 'co-dev-demo')).toHaveLength(1)
  expect(matches.filter(project => project.id !== 'co-dev-demo')).toHaveLength(1)
})
