import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  registerWorkflowReadySetAdvisor,
  registerWorkflowRunObserver,
} from '../workflows/runObservers.js'
import {
  adviseMatOSWorkflowReadySet,
  finalizeMatOSWorkflowController,
} from '../workflows/controllerBridge.js'
import type { MatOSWorkflowDefinition } from '../workflows/types.js'
import { refreshWorkflowBudgetLedger } from '../workflows/budget.js'
import {
  appendWorkflowEvent,
  readWorkflowRun,
  writeWorkflowRun,
} from '../workflows/workflowStore.js'
import { writeMatOSAlgorithmRunManifest } from './manifest.js'
import { recordWorkflowAlgorithmOutcome } from './outcomes/workflowOutcome.js'
import { flushMatOSAlgorithmRunDecisionReferences } from './runDecisionRefs.js'
import {
  noteMatOSAlgorithmRunTerminal,
  registerMatOSAlgorithmShadowLifecycleObserver,
} from './surface.js'

// Ensure every built-in surface is registered before a run manifest is frozen.
import './surfaces/contextRanking.js'
import './surfaces/approvalPolicy.js'
import './surfaces/workflowOptimize.js'
import './surfaces/toolSelection.js'
import './surfaces/continuationPolicy.js'
import './surfaces/inferenceRouting.js'
import './surfaces/assetSelection.js'
import './surfaces/verificationPolicy.js'
import './surfaces/recoveryPolicy.js'

let registered = false

export function ensureMatOSAlgorithmWorkflowIntegration(): void {
  if (registered) return
  registered = true
  registerWorkflowReadySetAdvisor(
    'matos-algorithm-controller',
    adviseMatOSWorkflowReadySet,
  )
  registerMatOSAlgorithmShadowLifecycleObserver(
    'matos-workflow-counterfactual-refresh',
    async lifecycle => {
      if (!lifecycle.runDir) return
      if (lifecycle.type === 'dropped') {
        await appendWorkflowEvent(lifecycle.runDir, {
          type: 'workflow.algorithm.shadow_dropped',
          data: {
            ...(lifecycle.surfaceId
              ? { surfaceId: lifecycle.surfaceId }
              : {}),
            ...(lifecycle.providerId
              ? { providerId: lifecycle.providerId }
              : {}),
            ...(lifecycle.primaryDecisionId
              ? { primaryDecisionId: lifecycle.primaryDecisionId }
              : {}),
            reason: lifecycle.reason,
            pendingForRun: lifecycle.pendingForRun,
            pendingTotal: lifecycle.pendingTotal,
            maxPendingForRun: lifecycle.maxPendingForRun,
            maxPendingTotal: lifecycle.maxPendingTotal,
          },
        })
        return
      }
      await flushMatOSAlgorithmRunDecisionReferences(lifecycle.runDir)
      const snapshot = await readWorkflowRun(lifecycle.runDir)
      if (
        snapshot.status !== 'completed' &&
        snapshot.status !== 'failed' &&
        snapshot.status !== 'cancelled'
      ) {
        return
      }
      await appendWorkflowEvent(lifecycle.runDir, {
        type: 'workflow.algorithm.shadow_drained',
        data: {
          pendingForRun: lifecycle.pendingForRun,
          pendingTotal: lifecycle.pendingTotal,
          refresh: 'terminal-outcome',
        },
      })
      // Bump the native run revision. The ordinary terminal observer then
      // writes a new outcome generation that includes the shadow references.
      await writeWorkflowRun(lifecycle.runDir, snapshot)
    },
  )
  registerWorkflowRunObserver(
    'matos-algorithm-layer',
    async event => {
      if (event.phase === 'created') {
        const definition = JSON.parse(
          await readFile(
            join(event.runDir, event.snapshot.graphSnapshotPath),
            'utf8',
          ),
        ) as MatOSWorkflowDefinition
        await writeMatOSAlgorithmRunManifest({
          runDir: event.runDir,
          runId: event.snapshot.runId,
          workflowRef: event.snapshot.workflowRef,
          workflowAlgorithms: definition.policy?.algorithms,
          workflowDefinition: definition,
          projectCwd: event.snapshot.projectCwd,
        })
      }
      if (
        event.snapshot.status === 'completed' ||
        event.snapshot.status === 'failed' ||
        event.snapshot.status === 'cancelled'
      ) {
        noteMatOSAlgorithmRunTerminal(event.runDir)
        let definition: MatOSWorkflowDefinition | undefined
        try {
          definition = JSON.parse(
            await readFile(
              join(event.runDir, event.snapshot.graphSnapshotPath),
              'utf8',
            ),
          ) as MatOSWorkflowDefinition
        } catch {
          definition = undefined
        }
        if (definition) {
          await finalizeMatOSWorkflowController({
            runDir: event.runDir,
            snapshot: event.snapshot,
            definition,
          })
          // Outcome completeness consumes the native budget ledger. Refresh it
          // from durable node attempts before recording the terminal outcome;
          // a diagnostic write failure must not block the user-visible run.
          await refreshWorkflowBudgetLedger(event.runDir, definition).catch(
            () => undefined,
          )
        }
        await recordWorkflowAlgorithmOutcome({
          runDir: event.runDir,
          snapshot: event.snapshot,
        })
      }
    },
    { failClosedOnCreate: true },
  )
}
