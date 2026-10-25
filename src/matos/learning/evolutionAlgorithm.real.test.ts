import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  runMatOSSelfEvolutionForSession,
  runMatOSSelfEvolutionForWorkflowEvidence,
} from './evolutionMonitor.js'
import { readMatOSDirectAssetEditorRunRecord } from './directAssetEditorRecords.js'
import { startWorkflowRun } from '../workflows/workflowRuntime.js'
import { buildWorkflowEvidenceFromRunDir } from './workflowEvidence.js'
import type { MatOSWorkflowDefinition } from '../workflows/types.js'

const enabled =
  process.env.MATOS_RUN_REAL_LLM_TESTS === '1' &&
  Boolean(process.env.DEEPSEEK_API_KEY)

test.skipIf(!enabled).each(['session', 'workflow'] as const)(
  'real provider: native %s evolution uses pinned policy and real asset validation',
  async (lane) => {
    const cwd = await mkdtempInMatOSTmp({
      prefix: 'matos-evolution-algorithm-real-',
    })
    const pack = join(cwd, 'matos-assets/packs/matos-core')
    await mkdir(pack, { recursive: true })
    for (const path of [
      'roles/user-feedback-critic',
      'roles/direct-asset-editor',
      'roles/semantic-acceptance-judge',
      'roles/self-evolution-worker',
      'skills/system-role',
      'tools/files-core',
    ]) {
      await cp(
        resolve(
          import.meta.dir,
          '../../..',
          'matos-assets/packs/matos-core',
          path,
        ),
        join(pack, path),
        { recursive: true },
      )
    }
    const knowledge = join(pack, 'knowledge/pressure-reporting')
    await mkdir(knowledge, { recursive: true })
    await writeFile(
      join(knowledge, 'asset.json'),
      JSON.stringify({
        schemaVersion: 1,
        type: 'knowledge',
        id: 'pressure-reporting',
        version: '0.1.0',
        name: 'Pressure reporting',
        description: 'Pressure units for materials development reports.',
        entry: 'KNOWLEDGE.md',
      }),
    )
    await writeFile(
      join(knowledge, 'KNOWLEDGE.md'),
      '# Pressure reporting\n\nReport pressure in Pa.\n',
    )
    const workflow = join(pack, 'workflows/pressure-conversion')
    const workflowPath = join(workflow, 'workflow.json')
    const workflowRef = 'workflow:pressure-conversion@0.1.0'
    if (lane === 'workflow') {
      await mkdir(workflow, { recursive: true })
      await writeFile(
        join(workflow, 'asset.json'),
        JSON.stringify({
          schemaVersion: 1,
          type: 'workflow',
          id: 'pressure-conversion',
          version: '0.1.0',
          name: 'Pressure conversion',
          description:
            'Convert 100000 Pa to 100 kPa. Preserve the independent expected-value check.',
          entry: 'workflow.json',
        }),
      )
      const script =
        'const pressurePa=100000; const pressureKPa=pressurePa/100; require("node:fs").writeFileSync("pressure.json",JSON.stringify({pressureKPa,unit:"kPa"})); if(pressureKPa!==100){console.error("Incorrect Pa-to-kPa conversion: expected 100 kPa for 100000 Pa. The divisor must be 1000, not 100.");process.exit(1)}'
      const definition: MatOSWorkflowDefinition = {
        schemaVersion: 1,
        name: 'Pressure conversion',
        parameters: {},
        policy: {},
        nodes: [
          {
            id: 'convert',
            type: 'exec',
            dependsOn: [],
            command: `node -e '${script}'`,
          },
        ],
        outputs: {},
      }
      await writeFile(workflowPath, JSON.stringify(definition, null, 2))
    }
    if (lane === 'session') {
      const policyRoot = join(cwd, 'algorithm-policies/supported')
      await mkdir(policyRoot, { recursive: true })
      await writeFile(
        join(policyRoot, 'asset.json'),
        JSON.stringify({
          schemaVersion: 1,
          type: 'tool',
          id: 'supported-evolution',
          version: '1.0.0',
          name: 'Supported evolution policy',
          entry: 'strategy.cjs',
          metadata: {
            algorithmSurface: 'evolution-policy',
            decisionProtocol: 'json-v1',
          },
        }),
      )
      await writeFile(
        join(policyRoot, 'strategy.cjs'),
        `
const { input } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
const action = input.phase === 'observed' ? 'analyze' : input.phase === 'evaluated' ? 'retain' : 'edit'
process.stdout.write(JSON.stringify({ decision: { action, signalIds: input.signals.filter(s => s.evidenceSupport === 'supported' && s.confidence >= 0.7).slice(0, 1).map(s => s.id) } }))
`,
      )
    }
    await mkdir(join(cwd, '.matos'), { recursive: true })
    await writeFile(
      join(cwd, '.matos/matos.json'),
      JSON.stringify({
        version: 1,
        includeDefaultAssetRoots: false,
        assetRoots: ['../matos-assets'],
        assetSources:
          lane === 'session'
            ? [
                {
                  id: 'algorithm-policies',
                  type: 'local',
                  scope: 'core',
                  path: '../algorithm-policies',
                },
              ]
            : [],
      }),
    )
    const oldEnv = { ...process.env }
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      HOME: join(cwd, 'home'),
      MATOS_AGENT_HOME: join(cwd, 'home/.matos'),
      MATOS_ASSET_ROOT: join(cwd, 'matos-assets'),
      MATOS_EDITABLE_CORE_ASSET_ROOT: pack,
      MATOS_SCOPE_REF: 'core',
      MATOS_SCOPE_ID: 'core',
      MATOS_USER_ID: 'local',
      MATOS_SESSION_DIR: join(cwd, '.matos/sessions'),
      MATOS_EVOLUTION_MONITOR_DIR: join(
        cwd,
        '.matos/evolution/monitor/sessions',
      ),
      MATOS_ALGO_EVOLUTION_POLICY:
        lane === 'session'
          ? 'asset:tool:supported-evolution@1.0.0'
          : 'evidence-first',
      MATOS_ALGO_CAPTURE: '1',
      MATOS_ALGO_TELEMETRY: '1',
      MATOS_EVOLUTION_ROLE_MODEL: 'deepseek-flash',
      MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '1',
      MATOS_EVOLUTION_ROLE_TIMEOUT_MS: '180000',
      MATOS_EVOLUTION_GITEA_REVIEW: '0',
    }
    Object.assign(process.env, env)
    try {
      await mkdir(env.MATOS_SESSION_DIR, { recursive: true })
      const sessionPath = join(env.MATOS_SESSION_DIR, 'real-policy-smoke.jsonl')
      const event = {
        id: 'pressure-correction',
        sessionId: 'real-policy-smoke',
        scopeRef: 'core',
        timestamp: new Date().toISOString(),
        type: 'matos.turn.started',
        data: {
          prompt:
            'The materials development report used Pa but our required output unit is kPa. Please correct knowledge:pressure-reporting@0.1.0 so future reports convert pressure from Pa to kPa by dividing by 1000 and label it kPa. This is our reusable reporting convention, not a one-off value. Keep all other assets unchanged.',
        },
      }
      await writeFile(sessionPath, JSON.stringify(event) + '\n')
      let records
      if (lane === 'session') {
        records = await runMatOSSelfEvolutionForSession(
          {
            cwd,
            sessionId: event.sessionId,
            sessionPath,
            trigger: {
              kind: 'user-feedback',
              key: 'user-feedback:pressure-correction',
              summary: 'Explicit reusable pressure unit correction.',
              eventId: event.id,
              targetAssetTypes: ['knowledge'],
              targetAssetRefs: ['knowledge:pressure-reporting@0.1.0'],
            },
          },
          { env },
        )
      } else {
        const definition = JSON.parse(
          await readFile(workflowPath, 'utf8'),
        ) as MatOSWorkflowDefinition
        const failures = []
        for (let attempt = 0; attempt < 2; attempt++) {
          const failed = await startWorkflowRun({
            cwd,
            workflowsDir: join(cwd, '.matos/workflows'),
            workflowRef,
            definition,
            parameters: {},
            workspaceDir: cwd,
          })
          expect(failed.status).toBe('failed')
          failures.push(failed)
        }
        const failed = failures[1]!
        const evidence = await buildWorkflowEvidenceFromRunDir({
          cwd,
          runDir: failed.runDir,
        })
        const nodeRecord = JSON.parse(
          await readFile(
            join(failed.runDir, 'node-runs/convert/node-run.json'),
            'utf8',
          ),
        )
        evidence.occurrenceCount = failures.length
        evidence.relatedRunIds = failures.map((run) => run.runId)
        evidence.recovery = {
          classification: 'deterministic-conversion-error',
          nodeId: 'convert',
          recommendedAction: `Inspect and repair ${workflowRef}; preserve the independent expected-value check and output pressure.json.`,
          reason: JSON.stringify(nodeRecord.error),
        }
        records = await runMatOSSelfEvolutionForWorkflowEvidence(
          { cwd, evidence },
          { env },
        )
      }
      const terminal = records?.at(-1)
      await writeFile(
        join(cwd, 'smoke-summary.json'),
        JSON.stringify(
          { statuses: records?.map((record) => record.status), terminal, cwd },
          null,
          2,
        ),
      )
      console.log(`Real evolution evidence: ${cwd}/smoke-summary.json`)
      expect(terminal?.status).toBe('direct-edit-complete')
      const run = await readMatOSDirectAssetEditorRunRecord(
        cwd,
        terminal!.directEditorRunId!,
      )
      expect(run?.status).toMatch(/^accepted/)
      expect(run?.semanticAcceptance?.verdict).toBe('accept')
      expect(
        run?.input.currentEvolutionContext?.algorithm?.decisions.map(
          (item) => item.phase,
        ),
      ).toEqual(['observed', 'analyzed', 'evaluated'])
      expect(run?.algorithmOutcomeRecorded).toBe(true)
      expect(
        run?.input.currentEvolutionContext?.algorithm?.binding.providerId,
      ).toBe(env.MATOS_ALGO_EVOLUTION_POLICY)
      if (lane === 'session') {
        expect(run?.acceptanceEvidence?.observedChanges?.actualRefs).toContain(
          'knowledge:pressure-reporting@0.1.0',
        )
        expect(
          await readFile(join(knowledge, 'KNOWLEDGE.md'), 'utf8'),
        ).toContain('kPa')
      } else {
        expect(run?.acceptanceEvidence?.observedChanges?.actualRefs).toContain(
          workflowRef,
        )
        const definition = JSON.parse(
          await readFile(workflowPath, 'utf8'),
        ) as MatOSWorkflowDefinition
        const repaired = await startWorkflowRun({
          cwd,
          workflowsDir: join(cwd, '.matos/workflows'),
          workflowRef,
          definition,
          parameters: {},
          workspaceDir: cwd,
        })
        expect(repaired.status).toBe('completed')
        expect(
          JSON.parse(await readFile(join(cwd, 'pressure.json'), 'utf8')),
        ).toMatchObject({ pressureKPa: 100, unit: 'kPa' })
        await writeFile(
          join(cwd, 'workflow-verification.json'),
          JSON.stringify({
            workflowRunId: repaired.runId,
            status: repaired.status,
            output: JSON.parse(
              await readFile(join(cwd, 'pressure.json'), 'utf8'),
            ),
          }),
        )
      }
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in oldEnv)) delete process.env[key]
      Object.assign(process.env, oldEnv)
    }
  },
  600_000,
)
