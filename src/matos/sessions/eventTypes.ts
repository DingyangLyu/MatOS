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

import type { MatOSTraceContext } from './traceContext.js'

export type MatOSEventType =
  | 'matos.session.started'
  | 'matos.session.resume-linked'
  | 'matos.transcript.linked'
  | 'matos.asset.loaded'
  | 'matos.asset.used'
  | 'matos.provider.login.set'
  | 'matos.provider.login.tested'
  | 'matos.provider.login.reset'
  | 'matos.provider.request.started'
  | 'matos.provider.request.completed'
  | 'matos.role.switch.requested'
  | 'matos.role.switch.validated'
  | 'matos.role.switch.applied'
  | 'matos.role.switch.failed'
  | 'matos.turn.started'
  | 'matos.turn.context.assembled'
  | 'matos.agent.message'
  | 'matos.tool.call.started'
  | 'matos.tool.call.completed'
  | 'matos.permission.requested'
  | 'matos.permission.resolved'
  | 'matos.turn.completed'
  | 'matos.session.completed'
  | 'matos.session.failed'
  | 'matos.workspace.start.requested'
  | 'matos.workspace.started'
  | 'matos.workspace.start.failed'
  | 'matos.workspace.stopped'
  | 'matos.workspace.restarted'
  | 'matos.workspace.doctor.completed'
  | 'matos.workspace.pruned'
  | 'matos.workspace.job.started'
  | 'matos.workspace.job.completed'
  | 'matos.lab.action.completed'
  | 'matos.lab.action.failed'
  | 'matos.workspace.job.cancelled'
  | 'matos.workspace.quota.denied'
  | 'matos.workspace.project.attached'
  | 'matos.evolution.manual.requested'
  // Emitted once by event storage when a session JSONL file reaches its size
  // cap; later non-lifecycle events for that session are not persisted.
  | 'matos.session.storage.capped'
  // Structured user preference/rule evidence forwarded from a product memory
  // surface (currently the Open Design web memory panel). Recorded into a
  // dedicated bridge session JSONL and analyzed by the self-evolution
  // user-feedback pipeline; never emitted by the interactive agent loop.
  | 'matos.feedback.recorded'

export type MatOSEvent = {
  id: string
  schemaVersion?: 1
  traceId?: string
  sessionId: string
  parentSessionId?: string
  turnId?: string
  userId?: string
  scopeRef?: string
  workspaceId?: string
  runtimeRef?: string
  execution?: string
  roleRef?: string
  timestamp: string
  type: MatOSEventType
  data: Record<string, unknown>
}

export type MatOSEventInput = {
  type: MatOSEventType
  data?: Record<string, unknown>
  traceContext?: Partial<MatOSTraceContext>
}

export type MatOSSessionSummary = {
  sessionId: string
  path: string
  traceId: string | undefined
  userId: string | undefined
  scopeRef: string | undefined
  workspaceId: string | undefined
  runtimeRef: string | undefined
  execution: string | undefined
  roleRef: string | undefined
  command: string | undefined
  cwd: string | undefined
  startedAt: string | undefined
  lastEventAt: string | undefined
  lastEventType: MatOSEventType | undefined
  eventCount: number
  turnCount: number
  assetCount: number
  assetUsageCount: number
  toolCallCount: number
  totalCostUsd: number | undefined
  durationMs: number | undefined
  numTurns: number | undefined
  status: 'running' | 'completed' | 'failed' | undefined
  hidden: boolean
}

export type MatOSTraceSummary = {
  traceId: string
  sessionIds: string[]
  paths: string[]
  userId: string | undefined
  scopeRef: string | undefined
  workspaceId: string | undefined
  runtimeRef: string | undefined
  execution: string | undefined
  roleRef: string | undefined
  command: string | undefined
  cwd: string | undefined
  startedAt: string | undefined
  lastEventAt: string | undefined
  lastEventType: MatOSEventType | undefined
  eventCount: number
  turnCount: number
  assetCount: number
  assetUsageCount: number
  toolCallCount: number
  workflowEventCount: number
  totalCostUsd: number | undefined
  durationMs: number | undefined
  numTurns: number | undefined
  status: 'running' | 'completed' | 'failed' | undefined
  hidden: boolean
}

export type MatOSEventSource = MatOSEvent & {
  sourcePath: string
}

export type MatOSWorkflowTraceEvent = {
  id: string
  timestamp: string
  type: string
  data: Record<string, unknown>
  trace?: MatOSTraceContext
  sourcePath: string
  runId?: string
}
