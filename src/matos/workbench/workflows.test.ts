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

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import type { MatOSWorkflowDefinition } from '../workflows/types.js'
import {
  sendMatOSWorkbenchWorkflowBuilderSession,
  sendMatOSWorkbenchWorkflowIntakeSession,
  startMatOSWorkbenchWorkflowBuilderSession,
  startMatOSWorkbenchWorkflowIntakeSession,
} from './workflows.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeWorkbenchWorkflowAsset(root: string): Promise<void> {
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'intake-smoke')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'intake-smoke',
    type: 'workflow',
    name: 'Intake Smoke',
    version: '0.1.0',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'executable', approvalMode: 'bypass' } },
  })
  await writeFile(
    join(workflowDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: intake-smoke',
      'version: "0.1.0"',
      'parameters:',
      '  structure_path:',
      '    type: string',
      '    required: true',
      '    format: path',
      '    description: Workspace-visible structure path.',
      '  cutoff:',
      '    type: number',
      '    required: true',
      '  use_spin:',
      '    type: boolean',
      '    default: false',
      'nodes:',
      '  prepare:',
      '    type: exec',
      '    command: "printf ready"',
      'outputs:',
      '  structure_path:',
      '    value: "{{ parameters.structure_path }}"',
    ].join('\n'),
    'utf8',
  )
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function startWorkflowBuilderChatDaemon(root: string): Promise<{
  socketPath: string
  requests: Array<Record<string, unknown>>
  close: () => Promise<void>
}> {
  const socketPath = join(root, 'matos-builder-chat.sock')
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    socket.once('data', chunk => {
      const line = String(chunk).split('\n').find(item => item.trim()) ?? '{}'
      const request = JSON.parse(line) as Record<string, unknown>
      requests.push(request)
      const requestId = String(request.requestId || 'builder-chat')
      const sessionKey = String(request.sessionKey || 'workflow-builder-session')
      const turnId = String(request.turnId || 'turn-builder-chat-1')
      socket.write(`${JSON.stringify({
        schemaVersion: 1,
        requestId,
        kind: 'chatStreamAck',
        sessionKey,
        turnId,
        pid: 45678,
        status: 'running',
        outputOffset: 0,
        eventSequence: 0,
        upstreamSessionId: 'upstream-workflow-builder-1',
      })}\n`)
      socket.write(`${JSON.stringify({
        schemaVersion: 1,
        requestId,
        kind: 'chatStreamEvent',
        sessionKey,
        turnId,
        sequence: 1,
        event: {
          type: 'message_delta',
          status: 'running',
          summary: 'workflow builder role is planning',
        },
      })}\n`)
      socket.write(`${JSON.stringify({
        schemaVersion: 1,
        requestId,
        kind: 'chatStreamDone',
        sessionKey,
        turnId,
        status: 'completed',
        outputOffset: 128,
        eventSequence: 1,
        upstreamSessionId: 'upstream-workflow-builder-1',
      })}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    requests,
    close: () => closeServer(server),
  }
}

async function startWorkflowIntakeChatDaemon(root: string): Promise<{
  socketPath: string
  requests: Array<Record<string, unknown>>
  close: () => Promise<void>
}> {
  const socketPath = join(root, 'matos-intake-chat.sock')
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    socket.once('data', chunk => {
      const line = String(chunk).split('\n').find(item => item.trim()) ?? '{}'
      const request = JSON.parse(line) as Record<string, unknown>
      requests.push(request)
      const requestId = String(request.requestId || 'intake-chat')
      const sessionKey = String(request.sessionKey || 'workflow-intake-session')
      const turnId = String(request.turnId || 'turn-intake-chat-1')
      const assistantText = [
        '可以使用你提到的 POSCAR 和默认 cutoff。',
        '```json',
        '{"structure_path":"/workspace/group/shared/POSCAR","cutoff":520}',
        '```',
      ].join('\n')
      socket.write(`${JSON.stringify({
        schemaVersion: 1,
        requestId,
        kind: 'chatStreamAck',
        sessionKey,
        turnId,
        pid: 45679,
        status: 'running',
        outputOffset: 0,
        eventSequence: 0,
        upstreamSessionId: 'upstream-workflow-intake-1',
      })}\n`)
      socket.write(`${JSON.stringify({
        schemaVersion: 1,
        requestId,
        kind: 'chatStreamEvent',
        sessionKey,
        turnId,
        sequence: 1,
        event: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: assistantText },
          },
        },
      })}\n`)
      socket.write(`${JSON.stringify({
        schemaVersion: 1,
        requestId,
        kind: 'chatStreamDone',
        sessionKey,
        turnId,
        status: 'completed',
        outputOffset: 256,
        eventSequence: 1,
        upstreamSessionId: 'upstream-workflow-intake-1',
      })}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    requests,
    close: () => closeServer(server),
  }
}

function builderDefinition(): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'builder-smoke',
    version: '0.1.0',
    parameters: {
      structure_path: {
        type: 'string',
        required: true,
        format: 'path',
      },
    },
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    nodes: [
      {
        id: 'prepare',
        type: 'exec',
        dependsOn: [],
        command: 'printf ready',
      },
    ],
    outputs: {
      status: { value: 'ready' },
    },
  }
}

describe('MatOS workbench workflow sessions', () => {
  test('collects workflow intake parameters from natural key-value messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workbench-workflow-intake-'))
    await writeWorkbenchWorkflowAsset(root)

    const started = await startMatOSWorkbenchWorkflowIntakeSession({
      cwd: root,
      ref: 'workflow:intake-smoke',
      message: 'structure_path=/workspace/group/shared/POSCAR',
    })

    expect(started.status).toBe('collecting')
    expect(started.intake.inputPlan.missingQuestions).toEqual([
      expect.objectContaining({ field: 'cutoff' }),
    ])
    expect(
      started.intake.fields.find((field: { key?: string }) => field.key === 'structure_path')?.sourceCandidates,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'workspace_file' }),
        expect.objectContaining({ kind: 'manual' }),
      ]),
    )

    const sent = await sendMatOSWorkbenchWorkflowIntakeSession({
      cwd: root,
      sessionId: started.sessionId,
      message: [
        'cutoff: 520',
        'use_spin=false',
      ].join('\n'),
    })

    expect(sent.status).toBe('ready')
    expect(sent.parameters).toMatchObject({
      structure_path: '/workspace/group/shared/POSCAR',
      cutoff: 520,
      use_spin: false,
    })
    expect(sent.intake.canRun).toBe(true)
  })

  test('runs builder session through native draft validate compile and publish actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workbench-workflow-builder-'))
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })

    const started = await startMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      goal: 'Build a deterministic workflow builder smoke test.',
    })

    const created = await sendMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      sessionId: started.sessionId,
      request: {
        action: 'create_draft',
        id: 'builder-smoke-draft',
        name: 'Builder Smoke Draft',
        version: '0.1.0',
      },
    })

    expect(created.draftId).toBe('builder-smoke-draft')
    expect(created.events?.map((event: { type?: string }) => event.type)).toContain('create_draft')
    expect(created.phase).toMatchObject({
      source: 'native-matos-workflow-builder',
      state: 'user_reviewing_patch',
    })

    const replaced = await sendMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      sessionId: started.sessionId,
      request: {
        action: 'replace_definition',
        draftId: created.draftId,
        definition: builderDefinition(),
      },
    })

    expect(replaced.status).toBe('ready')
    expect(replaced.events?.at(-1)).toMatchObject({
      type: 'replace_definition',
      validationOk: true,
    })

    const validated = await sendMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      sessionId: started.sessionId,
      request: {
        action: 'validate_draft',
        draftId: created.draftId,
      },
    })

    expect(validated.status).toBe('ready')
    expect(validated.lastValidation).toMatchObject({ ok: true })

    const compiled = await sendMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      sessionId: started.sessionId,
      request: {
        action: 'compile_draft',
        draftId: created.draftId,
      },
    })

    expect(compiled.status).toBe('ready')
    expect(compiled.lastCompile).toMatchObject({
      workflowRef: 'draft:builder-smoke-draft',
    })
    expect(compiled.phase).toMatchObject({
      state: 'ready_to_publish',
      nativeAction: 'workflows.builderSession.publish_draft',
    })
    expect(compiled.publishReadiness).toMatchObject({
      source: 'native-workflow-publish-readiness',
      draftId: 'builder-smoke-draft',
      targetAssetKey: 'workflow:builder-smoke-draft@0.1.0',
      governance: 'local-asset-governance',
      usesScopedGitea: false,
      canPublish: true,
      compileOk: true,
    })

    const published = await sendMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      sessionId: started.sessionId,
      request: {
        action: 'publish_draft',
        draftId: created.draftId,
        id: 'builder-smoke-published',
        name: 'Builder Smoke Published',
        version: '0.1.0',
      },
    })

    expect(published.status).toBe('published')
    expect(published.workflowRef).toContain('workflow:builder-smoke-published')
    expect(published.events?.at(-1)).toMatchObject({
      type: 'publish_draft',
      status: 'completed',
    })
    expect(published.phase).toMatchObject({
      state: 'attach_suggested',
      nativeAction: 'workflows.attachRole',
    })
    expect(published.publishSummary).toMatchObject({
      workflowRef: published.workflowRef,
      assetKey: published.workflowRef,
    })
    // Unversioned so the suggestion cannot go stale when the bundled role
    // version moves (developer edits and accepted self-evolution both bump it).
    expect(published.attachSuggestion?.recommendedRoleRefs).toContain('role:compute')
  })

  test('previews scoped Gitea governance before workflow builder publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workbench-workflow-builder-gitea-'))
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })

    const started = await startMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      scopeRef: 'user:alice',
      goal: 'Build a scoped workflow publish preview.',
    })
    const created = await sendMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      scopeRef: 'user:alice',
      sessionId: started.sessionId,
      request: {
        action: 'create_draft',
        id: 'scoped-builder-smoke',
        name: 'Scoped Builder Smoke',
        version: '0.1.0',
      },
    })
    const compiled = await sendMatOSWorkbenchWorkflowBuilderSession({
      cwd: root,
      scopeRef: 'user:alice',
      sessionId: started.sessionId,
      request: {
        action: 'compile_draft',
        draftId: created.draftId,
      },
    })

    expect(compiled.publishReadiness).toMatchObject({
      targetAssetKey: 'workflow:scoped-builder-smoke@0.1.0',
      scope: 'user',
      scopeRef: 'user:alice',
      governance: 'scoped-gitea-accepted-ref',
      usesScopedGitea: true,
      canPublish: true,
    })
  })
})
