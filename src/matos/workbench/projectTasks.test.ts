import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMatOSProjectMetadataAtomic } from '../projectMetadata.js'
import {
  createMatOSProjectTask,
  listMatOSProjectTasks,
  updateMatOSProjectTask,
} from './projectTasks.js'

const roots: string[] = []

async function taskProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-project-tasks-'))
  roots.push(root)
  await writeMatOSProjectMetadataAtomic(root, {
    schemaVersion: 1,
    revision: 1,
    id: 'tasks-project',
    name: 'Tasks project',
    team: [
      { memberId: 'agent-compute', roleRef: 'role:compute@1.0.0' },
      { memberId: 'agent-academic', roleRef: 'role:academic@1.0.0' },
    ],
  })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MatOS project task ledger', () => {
  test('validates membership, idempotency, and task id collisions', async () => {
    const cwd = await taskProject()
    const input = {
      cwd,
      taskId: 'task-1',
      conversationId: 'main',
      roleRef: 'role:compute',
      prompt: 'Run the calculation.',
    }
    const created = await createMatOSProjectTask(input)
    expect(created.task).toMatchObject({
      taskId: 'task-1',
      memberId: 'agent-compute',
      roleRef: 'role:compute@1.0.0',
      status: 'queued',
    })
    expect((await createMatOSProjectTask(input)).task.createdAt).toBe(created.task.createdAt)
    await expect(createMatOSProjectTask({
      ...input,
      prompt: 'Different payload.',
    })).rejects.toThrow('task id collision')
    await expect(createMatOSProjectTask({
      ...input,
      sourceMessageId: 'different-source',
    })).rejects.toThrow('task id collision')
    await expect(createMatOSProjectTask({
      ...input,
      taskId: 'task-unknown',
      roleRef: 'role:workflow-builder',
    })).rejects.toThrow('not a project member')
  })

  test('enforces terminal status transitions and persists concurrent tasks', async () => {
    const cwd = await taskProject()
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      createMatOSProjectTask({
        cwd,
        taskId: `task-${index}`,
        conversationId: 'main',
        roleRef: index % 2 === 0 ? 'role:compute' : 'role:academic',
        prompt: `task prompt ${index}`,
      })))
    expect((await listMatOSProjectTasks({ cwd })).tasks).toHaveLength(10)

    await updateMatOSProjectTask({
      cwd,
      taskId: 'task-0',
      status: 'running',
      runId: 'run-0',
    })
    const recovered = await updateMatOSProjectTask({
      cwd,
      taskId: 'task-0',
      status: 'queued',
      runId: null,
      error: 'daemon restarted',
    })
    expect(recovered.task.status).toBe('queued')
    expect(recovered.task.runId).toBeUndefined()
    await updateMatOSProjectTask({
      cwd,
      taskId: 'task-0',
      status: 'running',
      runId: 'run-0-recovered',
      error: null,
    })
    const completed = await updateMatOSProjectTask({
      cwd,
      taskId: 'task-0',
      status: 'succeeded',
    })
    expect(completed.task).toMatchObject({ status: 'succeeded', runId: 'run-0-recovered' })
    expect(completed.task.error).toBeUndefined()
    await expect(updateMatOSProjectTask({
      cwd,
      taskId: 'task-0',
      status: 'running',
    })).rejects.toThrow('succeeded -> running')
  })

  test('recovers a crash-truncated final record before the next append', async () => {
    const cwd = await taskProject()
    await createMatOSProjectTask({
      cwd,
      taskId: 'task-before-crash',
      conversationId: 'main',
      roleRef: 'role:compute',
      prompt: 'Persist before crash.',
    })
    const ledger = join(cwd, '.matos', 'workbench', 'project-tasks.jsonl')
    await appendFile(ledger, '{"eventId":"torn-tail"', 'utf8')

    expect((await listMatOSProjectTasks({ cwd })).tasks).toHaveLength(1)
    await createMatOSProjectTask({
      cwd,
      taskId: 'task-after-restart',
      conversationId: 'main',
      roleRef: 'role:academic',
      prompt: 'Continue after restart.',
    })

    expect((await listMatOSProjectTasks({ cwd })).tasks).toHaveLength(2)
    expect(await readFile(ledger, 'utf8')).not.toContain('torn-tail')
  })

  test('normalizes a valid record missing only its final newline before append', async () => {
    const cwd = await taskProject()
    await createMatOSProjectTask({
      cwd,
      taskId: 'task-valid-tail',
      conversationId: 'main',
      roleRef: 'role:compute',
      prompt: 'Persist a complete final record.',
    })
    const ledger = join(cwd, '.matos', 'workbench', 'project-tasks.jsonl')
    await writeFile(ledger, (await readFile(ledger, 'utf8')).trimEnd(), 'utf8')

    await createMatOSProjectTask({
      cwd,
      taskId: 'task-after-valid-tail',
      conversationId: 'main',
      roleRef: 'role:academic',
      prompt: 'Append without joining JSON records.',
    })

    expect((await listMatOSProjectTasks({ cwd })).tasks.map(task => task.taskId)).toEqual([
      'task-valid-tail',
      'task-after-valid-tail',
    ])
    expect((await readFile(ledger, 'utf8')).endsWith('\n')).toBe(true)
  })

  test('does not silently discard corruption in the middle of the ledger', async () => {
    const cwd = await taskProject()
    await createMatOSProjectTask({
      cwd,
      taskId: 'task-valid',
      conversationId: 'main',
      roleRef: 'role:compute',
      prompt: 'Valid task.',
    })
    const ledger = join(cwd, '.matos', 'workbench', 'project-tasks.jsonl')
    await appendFile(ledger, 'not-json\n{}\n', 'utf8')

    await expect(listMatOSProjectTasks({ cwd })).rejects.toThrow(
      'Invalid MatOS project task ledger',
    )

    const validLine = (await readFile(ledger, 'utf8')).split('\n')[0]
    await writeFile(ledger, `${validLine}\ncomplete-but-broken\n`, 'utf8')
    await expect(listMatOSProjectTasks({ cwd })).rejects.toThrow(
      'Invalid MatOS project task ledger',
    )
  })
})
