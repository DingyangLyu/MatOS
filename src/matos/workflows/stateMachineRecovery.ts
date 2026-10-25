import { listWorkflowFrames } from './stateMachineStore.js'

export type StateMachineRecoveryRecommendation =
  | 'resume_current_frame'
  | 'advance_next_frame'
  | 'human_review'

export type StateMachineRecoveryEvidence = {
  frameCount: number
  latestFrameStatus?: string
  activeNodeId?: string
  frameIndex?: number
  recommendation: StateMachineRecoveryRecommendation
}

export async function classifyStateMachineRecovery(
  runDir: string,
): Promise<StateMachineRecoveryEvidence> {
  const frames = await listWorkflowFrames(runDir)
  const latest = frames.at(-1)
  if (!latest) {
    return { frameCount: 0, recommendation: 'resume_current_frame' }
  }
  const base = {
    frameCount: frames.length,
    latestFrameStatus: latest.status,
    activeNodeId: latest.activeNodeId,
    frameIndex: latest.index,
  }
  if (latest.status === 'completed') {
    return {
      ...base,
      recommendation: 'advance_next_frame',
    }
  }
  if (latest.status === 'waiting_input' || latest.status === 'waiting_approval') {
    return {
      ...base,
      recommendation: 'human_review',
    }
  }
  return {
    ...base,
    recommendation: 'resume_current_frame',
  }
}
