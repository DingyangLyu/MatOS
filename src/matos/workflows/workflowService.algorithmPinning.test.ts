import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { readMatOSAlgorithmRunDecisionReferences } from '../algorithms/runDecisionRefs.js'
import { matOSAlgorithmRunManifestPath } from '../algorithms/manifest.js'
import { matOSRecoveryPolicySurface } from '../algorithms/surfaces/recoveryPolicy.js'
import { matOSWorkflowService } from './workflowService.js'
import { resumeWorkflowRun } from './workflowRuntime.js'
import {
  createWorkflowRun,
  readWorkflowRun,
  writeWorkflowRun,
} from './workflowStore.js'

describe('workflow service algorithm pinning', () => {
  test('a corrupt required manifest blocks resume before the first node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-resume-manifest-'))
    const sideEffectPath = join(root, 'must-not-run.txt')
    const handle = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:resume-manifest@1.0.0',
      parameters: {},
      projectCwd: root,
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'resume-manifest',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'first-node',
            type: 'exec',
            dependsOn: [],
            command: `printf should-not-run > ${JSON.stringify(sideEffectPath)}`,
          },
        ],
      },
    })
    await writeFile(matOSAlgorithmRunManifestPath(handle.dir), '{}\n', 'utf8')

    await expect(resumeWorkflowRun(handle.dir)).rejects.toThrow(
      /manifest-required execution/i,
    )
    expect(await readFile(sideEffectPath, 'utf8').catch(() => undefined)).toBeUndefined()
    expect((await readWorkflowRun(handle.dir)).status).toBe('created')
  })

  test('recoverApply uses the original manifest pin and execution context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-recover-pin-'))
    const workflowsDir = join(root, 'workflows')
    const pinnedProviderId = 'test-recovery-manifest-pinned'
    const ambientProviderId = 'test-recovery-ambient'
    const previousAmbient = process.env.MATOS_ALGO_RECOVERY_POLICY
    matOSRecoveryPolicySurface.register({
      id: pinnedProviderId,
      decide: () => ({ action: 'wait', reason: 'manifest-pinned' }),
    })
    matOSRecoveryPolicySurface.register({
      id: ambientProviderId,
      decide: () => ({ action: 'fail', reason: 'ambient-provider' }),
    })
    try {
      delete process.env.MATOS_ALGO_RECOVERY_POLICY
      const handle = await createWorkflowRun({
        workflowsDir,
        workflowRef: 'workflow:recover-pin@1.0.0',
        parameters: {},
        projectCwd: root,
        workspaceDir: root,
        graphSnapshot: {
          schemaVersion: 1,
          name: 'recover-pin',
          parameters: {},
          policy: {
            approvalMode: 'bypass',
            defaultRisk: 'low',
            algorithms: { 'recovery-policy': pinnedProviderId },
          },
          outputs: {},
          nodes: [
            {
              id: 'draft',
              type: 'agent',
              dependsOn: [],
              role: 'role:deep-research',
              prompt: 'Return JSON.',
              outputSchema: {
                type: 'object',
                required: ['ok'],
                properties: { ok: { type: 'boolean' } },
              },
            },
          ],
        },
      })
      await mkdir(join(handle.dir, 'node-runs', 'draft'), { recursive: true })
      await writeFile(
        join(handle.dir, 'node-runs', 'draft', 'node-run.json'),
        `${JSON.stringify({
          nodeId: 'draft',
          status: 'failed',
          attempts: 1,
          updatedAt: new Date().toISOString(),
          output: { ok: 'not-a-boolean' },
          error: { message: 'Workflow node output schema failed: /ok must be boolean' },
        })}\n`,
        'utf8',
      )
      await writeWorkflowRun(handle.dir, {
        ...(await readWorkflowRun(handle.dir)),
        status: 'failed',
      })

      process.env.MATOS_ALGO_RECOVERY_POLICY = ambientProviderId
      const result = await matOSWorkflowService.recoverApply({
        cwd: root,
        runId: handle.runId,
        env: {
          MATOS_WORKFLOW_RUNS_DIR: join(workflowsDir, 'runs'),
          MATOS_ALGO_RECOVERY_POLICY: ambientProviderId,
        },
      })

      expect(result.appliedAction).toBe('wait')
      const references = await readMatOSAlgorithmRunDecisionReferences(handle.dir)
      expect(references).toContainEqual(
        expect.objectContaining({
          runId: handle.runId,
          surfaceId: 'recovery-policy',
          providerId: pinnedProviderId,
        }),
      )
    } finally {
      matOSRecoveryPolicySurface.unregister(pinnedProviderId)
      matOSRecoveryPolicySurface.unregister(ambientProviderId)
      if (previousAmbient === undefined) {
        delete process.env.MATOS_ALGO_RECOVERY_POLICY
      } else {
        process.env.MATOS_ALGO_RECOVERY_POLICY = previousAmbient
      }
    }
  })
})
