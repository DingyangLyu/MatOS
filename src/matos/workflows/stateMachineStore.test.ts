import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  appendWorkflowTransitionRecord,
  listWorkflowFrames,
  readWorkflowFrame,
  writeFrameNodeRun,
  writeWorkflowFrame,
} from './stateMachineStore.js'

describe('MatOS state-machine workflow frame store', () => {
  test('persists frame snapshots node runs and transition ledger records', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-state-machine-store-'))
    await writeWorkflowFrame(runDir, {
      frameId: 'frame-000001',
      index: 1,
      activeNodeId: 'draft',
      status: 'completed',
      state: { revision: 1 },
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:01.000Z',
    })
    await writeFrameNodeRun({
      runDir,
      frameIndex: 1,
      nodeRun: {
        nodeId: 'draft',
        status: 'completed',
        attempts: 1,
        updatedAt: '2026-06-07T00:00:01.000Z',
        idempotencyKey: 'frame-1-key',
      },
    })
    await appendWorkflowTransitionRecord({
      runDir,
      frameId: 'frame-000001',
      transition: { id: 'draft_to_review', from: 'draft', to: 'review' },
      status: 'selected',
    })

    expect((await readWorkflowFrame(runDir, 1)).activeNodeId).toBe('draft')
    expect((await listWorkflowFrames(runDir)).map(frame => frame.frameId)).toEqual([
      'frame-000001',
    ])
    expect(await readFile(join(runDir, 'frames', '000001', 'node-run.json'), 'utf8'))
      .toContain('"idempotencyKey": "frame-1-key"')
    expect(
      await readFile(
        join(runDir, 'transitions', 'transition-ledger.jsonl'),
        'utf8',
      ),
    ).toContain('"transitionId":"draft_to_review"')
  })

  test('listing frames tolerates a crash remnant frame dir without frame.json', async () => {
    // Regression: a kill between mkdir(frames/N) and the atomic frame.json
    // rename left a frame dir with no readable snapshot, and the throwing
    // listing bricked inspection, recovery classification, and resume.
    const runDir = await mkdtemp(join(tmpdir(), 'matos-state-machine-partial-'))
    await writeWorkflowFrame(runDir, {
      frameId: 'frame-000001',
      index: 1,
      activeNodeId: 'draft',
      status: 'completed',
      state: {},
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:01.000Z',
    })
    // Crash remnant: dir exists, frame.json never landed (only a temp file).
    await mkdir(join(runDir, 'frames', '000002'), { recursive: true })
    await writeFile(
      join(runDir, 'frames', '000002', 'frame.json.tmp.1.partial'),
      '{"frameId":"frame-0000',
      'utf8',
    )

    const frames = await listWorkflowFrames(runDir)
    expect(frames.map(frame => frame.frameId)).toEqual(['frame-000001'])

    // The healed slot is reusable: the next frame write lands normally.
    await writeWorkflowFrame(runDir, {
      frameId: 'frame-000002',
      index: 2,
      activeNodeId: 'review',
      status: 'running',
      state: {},
      createdAt: '2026-06-07T00:00:02.000Z',
      updatedAt: '2026-06-07T00:00:02.000Z',
    })
    expect((await listWorkflowFrames(runDir)).map(frame => frame.frameId)).toEqual([
      'frame-000001',
      'frame-000002',
    ])
  })
})
