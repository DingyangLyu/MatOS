import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  MatOSWorkflowFrameSnapshot,
  MatOSWorkflowTransitionEdge,
} from './types.js'
import { transitionId } from './stateMachineTypes.js'
import { readJson, writeJson } from './jsonIo.js'

function frameDir(runDir: string, index: number): string {
  return join(runDir, 'frames', String(index).padStart(6, '0'))
}

export async function writeWorkflowFrame(
  runDir: string,
  frame: MatOSWorkflowFrameSnapshot,
): Promise<void> {
  const dir = frameDir(runDir, frame.index)
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'frame.json'), frame)
}

export async function readWorkflowFrame(
  runDir: string,
  index: number,
): Promise<MatOSWorkflowFrameSnapshot> {
  return readJson<MatOSWorkflowFrameSnapshot>(
    join(frameDir(runDir, index), 'frame.json'),
  )
}

export async function listWorkflowFrames(
  runDir: string,
): Promise<MatOSWorkflowFrameSnapshot[]> {
  let entries: string[]
  try {
    entries = await readdir(join(runDir, 'frames'))
  } catch {
    return []
  }
  const frames: MatOSWorkflowFrameSnapshot[] = []
  for (const entry of entries.sort()) {
    const index = Number(entry)
    if (!Number.isInteger(index) || index < 1) {
      continue
    }
    try {
      frames.push(await readWorkflowFrame(runDir, index))
    } catch {
      // A frame dir without a readable frame.json is a crash remnant: the
      // holder died between mkdir and the atomic frame.json rename, so the
      // frame never existed durably. Skip it instead of failing the whole
      // listing (which would brick inspection, recovery, and resume for the
      // run); the next frame write reuses and heals the dangling slot.
      continue
    }
  }
  return frames
}

export async function writeFrameNodeRun(input: {
  runDir: string
  frameIndex: number
  nodeRun: unknown
}): Promise<void> {
  await writeJson(
    join(frameDir(input.runDir, input.frameIndex), 'node-run.json'),
    input.nodeRun,
  )
}

export async function readFrameNodeRun<T = unknown>(
  runDir: string,
  frameIndex: number,
): Promise<T> {
  return readJson<T>(join(frameDir(runDir, frameIndex), 'node-run.json'))
}

export async function appendWorkflowTransitionRecord(input: {
  runDir: string
  frameId: string
  transition: MatOSWorkflowTransitionEdge
  status: 'selected' | 'rejected'
  reason?: string
}): Promise<void> {
  await mkdir(join(input.runDir, 'transitions'), { recursive: true })
  await writeFile(
    join(input.runDir, 'transitions', 'transition-ledger.jsonl'),
    `${JSON.stringify({
      frameId: input.frameId,
      transitionId: transitionId(input.transition),
      from: input.transition.from,
      to: input.transition.to,
      status: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
      timestamp: new Date().toISOString(),
    })}\n`,
    { flag: 'a' },
  )
}
