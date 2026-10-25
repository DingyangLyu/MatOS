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

// Detached workflow advance worker, shared by the agent-facing workflow_run
// tool (wait=false) and the CLI `matos workflow run --detach` path. A run
// created with `advance: false` sits in `created` state; the worker below
// picks it up via `matos workflow resume <runId>` in a separate detached
// process so the caller (agent turn, daemon HTTP request, CLI invocation)
// can return immediately while run.json / events.jsonl stay authoritative.

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowRunView } from './runtimeTypes.js'

// Resolve how a detached background worker should invoke the matos CLI.
// Explicit MATOS_CLI_BIN wins; otherwise reuse the same source-entrypoint
// launch shape the current process was started with (`<bun> <src>`), which
// resolves both in the host repo and under /app inside containers.
function resolveDetachedMatOSCliInvocation(): { command: string; args: string[] } {
  const explicit = process.env.MATOS_CLI_BIN?.trim()
  if (explicit) {
    return { command: explicit, args: [] }
  }
  const entry = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'entrypoints',
    'matos.ts',
  )
  if (existsSync(entry)) {
    return { command: process.execPath, args: [entry] }
  }
  return { command: 'matos', args: [] }
}

export type DetachedWorkflowAdvanceResult =
  | { ok: true }
  | { ok: false; error: string }

// Start a detached `matos workflow resume <runId>` worker that advances a
// deferred-start run after the caller has returned. The worker's output goes
// to a log inside the run dir; run state/events remain authoritative in
// run.json / events.jsonl.
export function spawnDetachedWorkflowAdvance(input: {
  cwd: string
  scopeRef?: string
  sessionId?: string
  run: Pick<WorkflowRunView, 'runId' | 'runDir'>
}): DetachedWorkflowAdvanceResult {
  try {
    const invocation = resolveDetachedMatOSCliInvocation()
    const logPath = join(input.run.runDir, 'detached-runner.log')
    const logFd = openSync(logPath, 'a')
    try {
      const child = spawn(
        invocation.command,
        [
          ...invocation.args,
          'workflow',
          'resume',
          input.run.runId,
          ...(input.scopeRef ? ['--scope', input.scopeRef] : []),
          '--json',
        ],
        {
          cwd: input.cwd,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, MATOS_WORKFLOW_SESSION_ID: input.sessionId },
        },
      )
      // spawn failures (e.g. the resolved CLI binary is missing from PATH)
      // surface asynchronously as an 'error' event; without a listener that
      // is an uncaught exception in THIS process — the agent/daemon host —
      // not in the worker. Record it in the run-local log instead, where the
      // stalled-run detection and `workflow resume` guidance already point.
      child.on('error', error => {
        try {
          appendFileSync(
            logPath,
            `[detached-runner] failed to start worker for ${input.run.runId}: ${
              error instanceof Error ? error.message : String(error)
            }\nAdvance the run manually with: matos workflow resume ${input.run.runId}\n`,
          )
        } catch {
          // Logging is best-effort; the run stays in `created` and pulse
          // reports it stalled via the updatedAt fallback.
        }
      })
      child.unref()
    } finally {
      closeSync(logFd)
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
