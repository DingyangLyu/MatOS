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

import { dirname, join } from 'node:path'
import type { MatOSWorkflowNode } from '../types.js'
import type { WorkflowRunView } from '../runtimeTypes.js'
import { readWorkflowRunControlAction } from '../workflowControl.js'
import {
  resolvePinnedChildWorkflow,
  type PinnedChildWorkflow,
} from '../childWorkflowSnapshot.js'
import {
  metadataObject,
  NON_TERMINAL_ITERATION_CHILD_STATUSES,
  readIteration,
  runIterationChild,
  selectedOutputs,
  stringList,
  writeIteration,
  writeIterationRetry,
  writeRoundState,
  type IterationNodeResult,
  type IterationNodeRunOptions,
  type IterationWorkflowRunInput,
} from './iterationNodeCommon.js'

type MapIterationRecord = {
  index: number
  item: unknown
  childRunId: string
  status: string
  outputs: Record<string, unknown>
  retryOfChildRunId?: string
  retryAttempt?: number
}

type MapFailureRecord = {
  index: number
  item: unknown
  childRunId: string
  status: string
  outputs: Record<string, unknown>
}

function stripJsonCodeFence(value: string): string {
  const match = value
    .trim()
    .match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/)
  return match?.[1]?.trim() ?? value.trim()
}

export function normalizeWorkflowMapItems(
  value: unknown,
  depth = 0,
): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value !== 'string') {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Array.isArray((value as Record<string, unknown>).items)
    ) {
      return (value as Record<string, unknown>).items as unknown[]
    }
    return undefined
  }
  const trimmed = stripJsonCodeFence(value)
  if (!trimmed) {
    return undefined
  }
  if (
    depth < 3 &&
    (trimmed.startsWith('[') ||
      trimmed.startsWith('"') ||
      trimmed.startsWith('{'))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        return parsed
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Array.isArray((parsed as Record<string, unknown>).items)
      ) {
        return (parsed as Record<string, unknown>).items as unknown[]
      }
      if (typeof parsed === 'string') {
        return normalizeWorkflowMapItems(parsed, depth + 1)
      }
    } catch {
      // Fall through to the comma-separated shorthand below.
    }
  }
  // Comma-separated shorthand is for plain text lists ("a, b, c") only.
  // Text that *looks* like JSON but failed to parse (e.g. an object with a
  // trailing comma, or a malformed array) must not be split on commas — that
  // produced garbage items like '{"a": 1' fanning out to child runs.
  if (
    trimmed.includes(',') &&
    !trimmed.startsWith('{') &&
    !trimmed.startsWith('[') &&
    !trimmed.startsWith('"')
  ) {
    return trimmed
      .split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0)
  }
  return undefined
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function mapIterationRecord(value: unknown): MapIterationRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.index !== 'number' ||
    typeof record.childRunId !== 'string' ||
    typeof record.status !== 'string'
  ) {
    return undefined
  }
  return {
    index: record.index,
    item: record.item,
    childRunId: record.childRunId,
    status: record.status,
    outputs: metadataObject(record.outputs),
    ...(typeof record.retryOfChildRunId === 'string'
      ? { retryOfChildRunId: record.retryOfChildRunId }
      : {}),
    ...(typeof record.retryAttempt === 'number'
      ? { retryAttempt: record.retryAttempt }
      : {}),
  }
}

function mapFailureRecord(value: unknown): MapFailureRecord | undefined {
  const record = mapIterationRecord(value)
  if (!record) {
    return undefined
  }
  return {
    index: record.index,
    item: record.item,
    childRunId: record.childRunId,
    status: record.status,
    outputs: record.outputs,
  }
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function mapMaxParallel(node: MatOSWorkflowNode): number {
  const policyConcurrency =
    node.policy?.concurrency &&
    typeof node.policy.concurrency === 'object' &&
    !Array.isArray(node.policy.concurrency)
      ? (node.policy.concurrency as Record<string, unknown>)
      : undefined
  const value =
    positiveInteger(node.maxParallel) ??
    positiveInteger(policyConcurrency?.maxParallel) ??
    positiveInteger(node.policy?.maxParallel) ??
    1
  return Math.min(32, value)
}

function mapMaxItems(node: MatOSWorkflowNode): number | undefined {
  return positiveInteger(node.maxItems)
}

function mapItemsOrThrow(node: MatOSWorkflowNode): unknown[] {
  const items = normalizeWorkflowMapItems(node.items)
  if (!items) {
    const actualType = Array.isArray(node.items)
      ? 'array'
      : node.items === null
        ? 'null'
        : typeof node.items
    throw new Error(
      `Map node items must resolve to an array: ${node.id} (actual ${actualType}). ` +
        'Use a real array, an exact template that returns an array, or valid JSON array text.',
    )
  }
  return items
}

async function runMapItem(input: {
  node: MatOSWorkflowNode
  item: unknown
  index: number
  baseParameters: Record<string, unknown>
  itemParameter: string
  outputKeys: string[]
  child: PinnedChildWorkflow
  options: IterationNodeRunOptions
}): Promise<MapIterationRecord> {
  const parameters = {
    ...input.baseParameters,
    [input.itemParameter]: input.item,
  }
  const childRun = await runIterationChild({
    node: input.node,
    child: input.child,
    cwd: input.options.cwd,
    workflowsDir: input.options.workflowsDir,
    workspaceDir: input.options.workspaceDir,
    parameters,
    startChildRun: input.options.startChildRun,
    onCreated: async run => {
      await writeIteration({
        runDir: input.options.runDir,
        nodeId: input.node.id,
        index: input.index,
        value: {
          index: input.index,
          item: input.item,
          childRunId: run.runId,
          status: 'running',
          outputs: {},
        },
      })
    },
  })
  const outputs = selectedOutputs(childRun.outputs, input.outputKeys)
  const iteration: MapIterationRecord = {
    index: input.index,
    item: input.item,
    childRunId: childRun.runId,
    status: childRun.status,
    outputs,
  }
  await writeIteration({
    runDir: input.options.runDir,
    nodeId: input.node.id,
    index: input.index,
    value: iteration,
  })
  await writeRoundState({
    runDir: input.options.runDir,
    nodeId: input.node.id,
    index: input.index,
    inputs: { item: input.item, parameters },
    childRun,
    outputs,
    decision: childRun.status === 'completed' ? 'continue' : 'fail',
    reason: childRun.status === 'completed' ? 'child_completed' : 'child_failed',
  })
  return iteration
}

async function runMapItemsBounded(input: {
  node: MatOSWorkflowNode
  items: unknown[]
  maxParallel: number
  aggregateFailures: boolean
  baseParameters: Record<string, unknown>
  itemParameter: string
  outputKeys: string[]
  child: PinnedChildWorkflow
  options: IterationNodeRunOptions
}): Promise<{ iterations: MapIterationRecord[]; cancelled: boolean }> {
  const results: MapIterationRecord[] = Array(input.items.length)
  let nextOffset = 0
  let stopLaunching = false
  let cancelRequested = false
  let firstError: Error | undefined

  // Adopt iterations that already completed in a previous attempt of this
  // node (crash recovery or a full-node retry): re-launching a child for an
  // item whose recorded input is identical just burns budget and duplicates
  // side effects.
  const priorIterations = await Promise.all(
    input.items.map((_, offset) =>
      readIteration({
        runDir: input.options.runDir,
        nodeId: input.node.id,
        index: offset + 1,
      }).then(mapIterationRecord),
    ),
  )

  async function worker(): Promise<void> {
    while (!stopLaunching) {
      // A run cancel request must stop the map from launching further child
      // workflows. Without this check an aggregate-mode map keeps starting
      // fresh children (which carry no cancel marker of their own) until
      // every item has run.
      if (
        (await readWorkflowRunControlAction(input.options.runDir)) === 'cancel'
      ) {
        cancelRequested = true
        stopLaunching = true
        return
      }
      if (stopLaunching) {
        return
      }
      const offset = nextOffset
      nextOffset += 1
      if (offset >= input.items.length) {
        return
      }
      const prior = priorIterations[offset]
      if (
        prior &&
        prior.status === 'completed' &&
        prior.childRunId &&
        JSON.stringify(prior.item) === JSON.stringify(input.items[offset])
      ) {
        results[offset] = prior
        continue
      }
      try {
        const iteration = await runMapItem({
          node: input.node,
          item: input.items[offset],
          index: offset + 1,
          baseParameters: input.baseParameters,
          itemParameter: input.itemParameter,
          outputKeys: input.outputKeys,
          child: input.child,
          options: input.options,
        })
        results[offset] = iteration
        if (iteration.status !== 'completed' && !input.aggregateFailures) {
          firstError = new Error(
            `Map child workflow did not complete: ${input.node.id} (${iteration.status})`,
          )
          stopLaunching = true
        }
      } catch (error) {
        firstError = error instanceof Error ? error : new Error(String(error))
        stopLaunching = true
      }
    }
  }

  const workerCount = Math.min(input.maxParallel, Math.max(1, input.items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (firstError && !cancelRequested) {
    throw firstError
  }
  return { iterations: results.filter(isDefined), cancelled: cancelRequested }
}

export async function runWorkflowMapNode(
  node: MatOSWorkflowNode,
  options: IterationNodeRunOptions,
): Promise<IterationNodeResult> {
  if (node.type !== 'map') {
    throw new Error(`Map node runner requires a map node: ${node.id}`)
  }
  const baseParameters = metadataObject(node.parameters)
  const outputKeys = stringList(node.outputKeys ?? node.outputs)
  const sourceItems = mapItemsOrThrow(node)
  const itemParameter =
    typeof node.itemParameter === 'string' && node.itemParameter.trim()
      ? node.itemParameter
      : 'item'
  const aggregateFailures = node.failureMode === 'aggregate'
  const failOnAnyChildFailure = node.failOnAnyChildFailure !== false
  const maxParallel = mapMaxParallel(node)
  const maxItems = mapMaxItems(node)
  const items =
    maxItems === undefined ? sourceItems : sourceItems.slice(0, maxItems)
  const child = await resolvePinnedChildWorkflow({
    cwd: options.cwd,
    runDir: options.runDir,
    node,
  })
  const bounded = await runMapItemsBounded({
    node,
    items,
    maxParallel,
    aggregateFailures,
    baseParameters,
    itemParameter,
    outputKeys,
    child,
    options,
  })
  const iterations = bounded.iterations
  const failures = iterations
    .filter(iteration => iteration.status !== 'completed')
    .map(iteration => ({
      index: iteration.index,
      item: iteration.item,
      childRunId: iteration.childRunId,
      status: iteration.status,
      outputs: iteration.outputs,
    }))
  const completedCount = iterations.length - failures.length
  const summary = {
    total: iterations.length,
    sourceTotal: sourceItems.length,
    completed: completedCount,
    failed: failures.length,
    maxParallel,
    ...(maxItems !== undefined ? { maxItems } : {}),
    truncated: items.length < sourceItems.length,
    ...(bounded.cancelled ? { cancelled: true } : {}),
  }
  const output = {
    count: iterations.length,
    completedCount,
    failedCount: failures.length,
    iterations,
    outputs: iterations.map(iteration => iteration.outputs),
    failures,
    summary,
  }
  if (bounded.cancelled) {
    return { output, cancelled: true }
  }
  return {
    output,
    ...(failures.length > 0 && failOnAnyChildFailure
      ? {
          failureMessage: `Map child workflows failed: ${node.id} (${failures.length}/${iterations.length})`,
        }
      : {}),
  }
}

export async function retryWorkflowMapFailedChildren(
  node: MatOSWorkflowNode,
  currentOutput: unknown,
  options: {
    cwd: string
    runDir: string
    workflowsDir: string
    workspaceDir: string
    retryAttempt: number
    startChildRun: (input: IterationWorkflowRunInput) => Promise<WorkflowRunView>
  },
): Promise<IterationNodeResult> {
  if (node.type !== 'map') {
    throw new Error(`Selective failed-child retry requires a map node: ${node.id}`)
  }
  if (node.failureMode !== 'aggregate') {
    throw new Error(
      `Selective failed-child retry requires failureMode aggregate: ${node.id}`,
    )
  }
  // Apply the same maxItems truncation as the original run. Merging against
  // the full source list would fabricate `pending` iterations (index beyond
  // maxItems, empty childRunId) that count as failures yet can never run.
  const sourceItems = mapItemsOrThrow(node)
  const maxItems = mapMaxItems(node)
  const items =
    maxItems === undefined ? sourceItems : sourceItems.slice(0, maxItems)
  const output = metadataObject(currentOutput)
  const iterations = Array.isArray(output.iterations)
    ? output.iterations.map(mapIterationRecord).filter(isDefined)
    : []
  const failures = Array.isArray(output.failures)
    ? output.failures.map(mapFailureRecord).filter(isDefined)
    : []
  if (failures.length === 0) {
    throw new Error(`Map node has no failed children to retry: ${node.id}`)
  }

  const byIndex = new Map<number, MapIterationRecord>()
  for (const iteration of iterations) {
    byIndex.set(iteration.index, iteration)
  }

  const baseParameters = metadataObject(node.parameters)
  const outputKeys = stringList(node.outputKeys ?? node.outputs)
  const itemParameter =
    typeof node.itemParameter === 'string' && node.itemParameter.trim()
      ? node.itemParameter
      : 'item'
  const child = await resolvePinnedChildWorkflow({
    cwd: options.cwd,
    runDir: options.runDir,
    node,
  })

  for (const failure of failures) {
    if (
      (await readWorkflowRunControlAction(options.runDir)) === 'cancel'
    ) {
      throw new Error(
        `Map selective retry stopped: workflow cancel requested: ${node.id}`,
      )
    }
    if (
      !Number.isInteger(failure.index) ||
      failure.index < 1 ||
      failure.index > items.length
    ) {
      throw new Error(`Map failure index is outside items: ${node.id}`)
    }
    const item = items[failure.index - 1]
    const parameters = { ...baseParameters, [itemParameter]: item }
    const childRun = await runIterationChild({
      node,
      child,
      cwd: options.cwd,
      workflowsDir: options.workflowsDir,
      workspaceDir: options.workspaceDir,
      parameters,
      startChildRun: options.startChildRun,
      onCreated: async run => {
        const activeRetry: MapIterationRecord = {
          index: failure.index,
          item,
          childRunId: run.runId,
          status: 'running',
          outputs: {},
          retryOfChildRunId: failure.childRunId,
          retryAttempt: options.retryAttempt,
        }
        await writeIterationRetry({
          runDir: options.runDir,
          nodeId: node.id,
          index: failure.index,
          retryAttempt: options.retryAttempt,
          value: activeRetry,
        })
        await writeIteration({
          runDir: options.runDir,
          nodeId: node.id,
          index: failure.index,
          value: activeRetry,
        })
      },
    })
    const outputs = selectedOutputs(childRun.outputs, outputKeys)
    const iteration: MapIterationRecord = {
      index: failure.index,
      item,
      childRunId: childRun.runId,
      status: childRun.status,
      outputs,
      retryOfChildRunId: failure.childRunId,
      retryAttempt: options.retryAttempt,
    }
    await writeIterationRetry({
      runDir: options.runDir,
      nodeId: node.id,
      index: failure.index,
      retryAttempt: options.retryAttempt,
      value: iteration,
    })
    await writeIteration({
      runDir: options.runDir,
      nodeId: node.id,
      index: failure.index,
      value: iteration,
    })
    await writeRoundState({
      runDir: options.runDir,
      nodeId: node.id,
      index: failure.index,
      retryAttempt: options.retryAttempt,
      inputs: {
        item,
        parameters,
        retryOfChildRunId: failure.childRunId,
      },
      childRun,
      outputs,
      decision: childRun.status === 'completed' ? 'continue' : 'fail',
      reason: childRun.status === 'completed' ? 'retry_completed' : 'retry_failed',
    })
    byIndex.set(failure.index, iteration)
  }

  const mergedIterations = Array.from({ length: items.length }, (_, offset) => {
    const index = offset + 1
    const existing = byIndex.get(index)
    if (existing) {
      return existing
    }
    return {
      index,
      item: items[index - 1],
      childRunId: '',
      status: 'pending',
      outputs: {},
    } satisfies MapIterationRecord
  })
  const mergedFailures = mergedIterations
    .filter(iteration => iteration.status !== 'completed')
    .map(iteration => ({
      index: iteration.index,
      item: iteration.item,
      childRunId: iteration.childRunId,
      status: iteration.status,
      outputs: iteration.outputs,
    }))
  const completedCount = mergedIterations.length - mergedFailures.length
  const summary = {
    total: mergedIterations.length,
    completed: completedCount,
    failed: mergedFailures.length,
  }
  const mergedOutput = {
    count: mergedIterations.length,
    completedCount,
    failedCount: mergedFailures.length,
    iterations: mergedIterations,
    outputs: mergedIterations.map(iteration => iteration.outputs),
    failures: mergedFailures,
    summary,
    retry: {
      failedChildrenOnly: true,
      retryAttempt: options.retryAttempt,
      retriedCount: failures.length,
      retriedIndices: failures.map(failure => failure.index),
    },
  }
  const failOnAnyChildFailure = node.failOnAnyChildFailure !== false
  return {
    output: mergedOutput,
    ...(mergedFailures.length > 0 && failOnAnyChildFailure
      ? {
          failureMessage: `Map child workflows failed after selective retry: ${node.id} (${mergedFailures.length}/${mergedIterations.length})`,
        }
      : {}),
  }
}
