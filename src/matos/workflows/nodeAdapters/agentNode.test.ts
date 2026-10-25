import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { startWorkflowRun } from '../workflowRuntime.js'
import { readWorkflowRunEvents } from '../workflowStore.js'
import { workflowAgentContractRepairFromNodeRun } from '../nodeExecutors.js'
import { workflowAgentContractRepairSection } from './agentNode.js'

const ORIGINAL_ENV = { ...process.env }
const AGENT_NODE_TEST_TIMEOUT_MS = Number.parseInt(
  process.env.MATOS_WORKFLOW_AGENT_TEST_TIMEOUT_MS ?? '60000',
  10,
)

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('workflow agent contract repair feedback', () => {
  test('repair section lists the prior contract errors for the retry prompt', () => {
    const section = workflowAgentContractRepairSection({
      errors: [
        'Agent node answer outputSchema failed: root: must have required property score',
        'Agent node answer outputSchema requires structured JSON output',
      ],
      previousAttempt: 1,
    })
    expect(section).toContain(
      'Your previous attempt (attempt 1) failed the output contract with these errors:',
    )
    expect(section).toContain(
      '- Agent node answer outputSchema failed: root: must have required property score',
    )
    expect(section).toContain(
      '- Agent node answer outputSchema requires structured JSON output',
    )
    expect(section).toContain('satisfies the node output contract')
  })

  test('derives repair feedback only from a persisted contract failure', () => {
    // Shape persisted by scheduleNodeRetry after a WorkflowNodeOutputContractError.
    const contractFailedRun = {
      nodeId: 'answer',
      status: 'pending' as const,
      attempts: 1,
      updatedAt: new Date().toISOString(),
      error: {
        message: 'Agent node answer outputSchema requires structured JSON output',
        code: 'output_contract_failed',
        details: {
          nodeId: 'answer',
          errors: [
            'Agent node answer outputSchema requires structured JSON output',
          ],
          output: {
            result: 'free text',
            upstreamSessionId: 'thread-repair-1',
          },
        },
      },
    }
    expect(workflowAgentContractRepairFromNodeRun(contractFailedRun)).toEqual({
      errors: ['Agent node answer outputSchema requires structured JSON output'],
      previousAttempt: 1,
      upstreamSessionId: 'thread-repair-1',
    })

    // A full manual node reset (resetNodeRun) drops the error: no feedback,
    // no thread resume.
    expect(
      workflowAgentContractRepairFromNodeRun({
        nodeId: 'answer',
        status: 'pending',
        attempts: 1,
        updatedAt: new Date().toISOString(),
      }),
    ).toBeUndefined()

    // Non-contract failures never trigger repair feedback.
    expect(
      workflowAgentContractRepairFromNodeRun({
        nodeId: 'answer',
        status: 'pending',
        attempts: 1,
        updatedAt: new Date().toISOString(),
        error: { message: 'network reset', code: 'ECONNRESET' },
      }),
    ).toBeUndefined()
  })

  test(
    'contract-repair retry sends the prior errors and resumes the same engine thread',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-agent-contract-repair-'))
      const capture = join(root, 'capture')
      await mkdir(capture, { recursive: true })
      // Fake agent entrypoint: records prompt and argv per invocation.
      // Attempt 1 answers with plain text (fails the outputSchema contract);
      // attempt 2 answers with valid structured JSON.
      const fakeAgent = join(root, 'fake-agent.ts')
      await writeFile(
        fakeAgent,
        [
          "import { readFileSync, writeFileSync } from 'node:fs'",
          "const dir = process.env.MATOS_TEST_AGENT_CAPTURE_DIR!",
          "let n = 0",
          "try { n = Number(readFileSync(dir + '/count', 'utf8')) } catch {}",
          "n += 1",
          "writeFileSync(dir + '/count', String(n))",
          "const args = process.argv.slice(2)",
          "const prompt = args[args.indexOf('-p') + 1] ?? ''",
          "writeFileSync(dir + '/prompt-' + n + '.txt', prompt)",
          "writeFileSync(dir + '/args-' + n + '.txt', args.join(' '))",
          "const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined",
          "const result = n === 1 ? 'the answer is plain text' : '{\"score\": 2}'",
          "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: resume ?? 'thread-repair-1', usage: { input_tokens: 3, output_tokens: 2 } }))",
        ].join('\n'),
        'utf8',
      )

      process.env.MATOS_TEST_AGENT_ENTRYPOINT_PATH = fakeAgent
      process.env.MATOS_RUNTIME_DATA_DIR = join(root, 'runtime')
      process.env.MATOS_SCOPE_REF = 'user:alice'
      process.env.MATOS_TEST_AGENT_CAPTURE_DIR = capture

      const run = await startWorkflowRun({
        cwd: root,
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:agent-repair@0.1.0',
        parameters: {},
        workspaceDir: root,
        definition: {
          schemaVersion: 1,
          name: 'agent-repair',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            {
              id: 'answer',
              type: 'agent',
              dependsOn: [],
              role: 'role:compute',
              prompt: 'Return the score as JSON.',
              outputSchema: {
                type: 'object',
                required: ['score'],
                properties: { score: { type: 'number' } },
              },
              // Keep the fake agent hermetic: no MCP/tool materialization.
              passthroughArgs: ['--tools', ''],
              policy: { retry: { maxAttempts: 2 } },
            },
          ],
        },
      })

      expect(run.status).toBe('completed')
      const answer = (run.nodes ?? []).find(node => node.nodeId === 'answer')
      expect(answer?.status).toBe('completed')
      expect(answer?.attempts).toBe(2)
      expect(
        (answer?.output as { structured?: { score?: number } }).structured,
      ).toEqual({ score: 2 })

      // P0-3: the retry prompt must contain the prior contract errors.
      const firstPrompt = await readFile(join(capture, 'prompt-1.txt'), 'utf8')
      const secondPrompt = await readFile(join(capture, 'prompt-2.txt'), 'utf8')
      expect(firstPrompt).not.toContain('failed the output contract')
      expect(secondPrompt).toContain(
        'failed the output contract with these errors:',
      )
      expect(secondPrompt).toContain(
        'outputSchema requires structured JSON output',
      )
      expect(secondPrompt).toContain('Return the score as JSON.')

      // P0-4: the retry resumes the failing attempt's engine thread instead
      // of opening a fresh, context-free session.
      const firstArgs = await readFile(join(capture, 'args-1.txt'), 'utf8')
      const secondArgs = await readFile(join(capture, 'args-2.txt'), 'utf8')
      expect(firstArgs).not.toContain('resume')
      expect(secondArgs).toContain('resume')
      expect(secondArgs).toContain('thread-repair-1')

      const eventTypes = (await readWorkflowRunEvents(run.runDir)).map(
        event => event.type,
      )
      expect(eventTypes).toContain('workflow.agent.contract_repair_requested')
    },
    AGENT_NODE_TEST_TIMEOUT_MS,
  )
})
