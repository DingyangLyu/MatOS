import { classifyMatOSTurnFeedbackWithLLM } from './turnFeedbackClassifier'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { runMatOSInit } from '../cli/init'
import { readMatOSProjectConfig, writeMatOSProjectConfig } from '../project'
import { standaloneEnvironmentDefaults } from '../standaloneProfile'
import { materializeMatOSAssetSource, commitMatOSGitAssetSource } from '../assets/sourceAdapters'
import { acceptMatOSGiteaAssetSourceCommit, readMatOSGiteaRemoteRefCommit } from '../assets/giteaAcceptance'
import { loadMatOSAssetsFromRoot } from '../assets/loadAssets'
import { validateMatOSAssets } from '../assets/validateAssets'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs'
import { startWorkflowRun } from '../workflows/workflowRuntime'
import { buildWorkflowEvidenceFromRunDir } from './workflowEvidence'
import { runMatOSSelfEvolutionForSession } from './evolutionMonitor'
import { readMatOSDirectAssetEditorRunRecord } from './directAssetEditorRecords'

const enabled = process.env.MATOS_RUN_REAL_LLM_TESTS === '1' && Boolean(process.env.DEEPSEEK_API_KEY)

test.skipIf(!enabled)('real Flash applies explicit workflow feedback through local Git acceptance', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'matos-public-evolution-' })
  const previous = { ...process.env }
  const scopeRef = 'project:public-evolution'
  const env = { ...process.env, ...standaloneEnvironmentDefaults(cwd, { scopeRef }),
    MATOS_BUNDLED_ASSET_ROOT: process.env.MATOS_REAL_EVOLUTION_ASSET_ROOT || resolve(import.meta.dir, '../../../distribution/benchmark-minimal/assets'),
    NODE_ENV: 'production', MATOS_SCOPE_ID: scopeRef, MATOS_USER_ID: 'local',
    MATOS_EVOLUTION_ROLE_MODEL: 'deepseek-flash', MATOS_EVOLUTION_ROLE_TIMEOUT_MS: '180000',
    MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '1', MATOS_EVOLUTION_EXPERIENCE_LAYER: 'off', MATOS_EVOLUTION_GITEA_REVIEW: '0',
    MATOS_GITEA_DISABLE_OPERATOR_ENV: '1', MATOS_ALGO_EVOLUTION_POLICY: 'evidence-first',
  }
  Object.assign(process.env, env)
  try {
    await runMatOSInit({ cwd, stdout: () => {}, stderr: () => {} }, { standalone: true, scopeRef })
    let config = await readMatOSProjectConfig(cwd)
    const source = config.assetSources!.find(source => source.type === 'git')!
    if (source.type !== 'git') throw new Error('Missing local Git source')
    const checkout = await materializeMatOSAssetSource(cwd, source)
    const folder = join(checkout, 'workflows/pressure-conversion')
    await mkdir(folder, { recursive: true })
    const ref = 'workflow:pressure-conversion@0.1.0'
    await writeFile(join(folder, 'asset.json'), JSON.stringify({ schemaVersion: 1, type: 'workflow',
      id: 'pressure-conversion', version: '0.1.0', name: 'Pressure conversion', entry: 'workflow.json',
      description: 'Convert 100000 Pa to 100 kPa and preserve the independent expected-value check.' }))
    const program = 'const pressurePa=100000; const pressureKPa=pressurePa/100; require("node:fs").writeFileSync("pressure.json",JSON.stringify({pressureKPa,unit:"kPa"})); if(pressureKPa!==100){console.error("Incorrect Pa-to-kPa conversion: expected 100 kPa for 100000 Pa; divide by 1000, not 100.");process.exit(1)}'
    const definition = { schemaVersion: 1, name: 'Pressure conversion', parameters: {}, policy: {}, outputs: {},
      nodes: [{ id: 'convert', type: 'exec', dependsOn: [], command: `node -e '${program}'` }] }
    const path = join(folder, 'workflow.json')
    await writeFile(path, JSON.stringify(definition, null, 2))
    const candidate = await commitMatOSGitAssetSource(cwd, source, { message: 'Seed workflow regression case', branch: 'fixture/pressure', push: true })
    const accepted = await acceptMatOSGiteaAssetSourceCommit({ cwd, source, ref: candidate.commit, push: true,
      validateRoot: async root => validateMatOSAssets(await loadMatOSAssetsFromRoot(root)) })
    expect(accepted.ok).toBe(true)
    config.assetSources = [{ ...source, runtimeRef: accepted.runtimeRef }]
    await writeMatOSProjectConfig(cwd, config)
    const run = () => startWorkflowRun({ cwd, workflowsDir: join(cwd, '.matos/workflows'), workflowRef: ref,
      definition: JSON.parse(require('node:fs').readFileSync(path, 'utf8')), parameters: {}, workspaceDir: cwd })
    const failures = [await run(), await run()]
    expect(failures.map(run => run.status)).toEqual(['failed', 'failed'])
    const evidence = await buildWorkflowEvidenceFromRunDir({ cwd, runDir: failures[1]!.runDir })
    evidence.occurrenceCount = 2
    evidence.relatedRunIds = failures.map(run => run.runId)
    evidence.recovery = { classification: 'deterministic-conversion-error', nodeId: 'convert',
      recommendedAction: `Repair ${ref}; keep the independent expected-value check and pressure.json output.`,
      reason: 'Two real runs failed their 100 kPa assertion for a 100000 Pa input.' }
    const sessionId = 'public-feedback'
    const sessionPath = join(cwd, '.matos/sessions/public-feedback.jsonl')
    await mkdir(join(cwd, '.matos/sessions'), { recursive: true })
    const event = { id: 'pressure-correction', sessionId, scopeRef, userId: 'local',
      timestamp: new Date().toISOString(), type: 'matos.turn.started', data: {
        prompt: 'Please correct workflow:pressure-conversion@0.1.0 in this project. The two recorded executions failed because Pa must be converted to kPa by dividing by 1000, not 100. Keep the existing independent check (100000 Pa equals 100 kPa) and pressure.json output. Fix this reusable workflow asset; leave other assets unchanged.',
        workflowEvidence: evidence,
      } }
    await writeFile(sessionPath, JSON.stringify(event) + '\n')
    const records = await runMatOSSelfEvolutionForSession({ cwd, sessionId, sessionPath,
      trigger: { kind: 'user-feedback', key: 'user-feedback:pressure-correction', eventId: event.id,
        summary: 'Explicit feedback based on two recorded pressure conversion failures.',
        targetAssetTypes: ['workflow'], targetAssetRefs: [ref] } }, { env })
    const terminal = records?.at(-1)
    const record = terminal?.directEditorRunId ? await readMatOSDirectAssetEditorRunRecord(cwd, terminal.directEditorRunId) : undefined
    await writeFile(join(cwd, 'smoke-summary.json'), JSON.stringify({ cwd, terminal, record }, null, 2))
    console.log(`Standalone evolution evidence: ${cwd}/smoke-summary.json`)
    expect(terminal?.status).toBe('direct-edit-complete')
    expect(record?.status).toMatch(/^accepted/)
    expect(record?.semanticAcceptance?.verdict).toBe('accept')
    config = await readMatOSProjectConfig(cwd)
    const finalSource = config.assetSources!.find(item => item.id === source.id)!
    expect(finalSource.type).toBe('git')
    if (finalSource.type !== 'git' || finalSource.runtimeRef?.mode !== 'accepted-ref') throw new Error('Missing accepted source')
    expect(finalSource.runtimeRef.commit).not.toBe(accepted.commit)
    expect(await readMatOSGiteaRemoteRefCommit({ checkoutRoot: checkout, ref: finalSource.runtimeRef.ref })).toBe(finalSource.runtimeRef.commit)
    expect((await run()).status).toBe('completed')
    expect(JSON.parse(await readFile(join(cwd, 'pressure.json'), 'utf8'))).toEqual({ pressureKPa: 100, unit: 'kPa' })
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}, 720_000)

test.skipIf(!enabled)('real Flash classifies feedback with the minimal hidden role',async()=>{
 const cwd=await mkdtempInMatOSTmp({prefix:'matos-public-classifier-'})
 const previous={...process.env}
 const scopeRef='project:public-classifier'
 Object.assign(process.env,{...standaloneEnvironmentDefaults(cwd,{scopeRef}),
  MATOS_BUNDLED_ASSET_ROOT:process.env.MATOS_REAL_EVOLUTION_ASSET_ROOT || resolve(import.meta.dir,'../../../distribution/benchmark-minimal/assets'),
  NODE_ENV:'production',MATOS_SCOPE_ID:scopeRef,MATOS_USER_ID:'local',
  MATOS_EVOLUTION_ROLE_MODEL:'deepseek-flash',
 })
 try{
  await runMatOSInit({cwd,stdout:()=>{},stderr:()=>{}},{standalone:true,scopeRef})
  const correction=await classifyMatOSTurnFeedbackWithLLM({cwd,sessionId:'classifier-check',eventId:'correction',
   prompt:'The previous workflow converted Pa to kPa incorrectly. Please divide by 1000 and preserve the independent expected-value check in future calculations.'})
  expect(correction?.isFeedback).toBe(true)
  expect(correction?.kinds).toContain('correction')
  const task=await classifyMatOSTurnFeedbackWithLLM({cwd,sessionId:'classifier-check',eventId:'new-task',
   prompt:'Calculate the arithmetic mean of 2, 4, and 6.'})
  expect(task?.isFeedback).toBe(false)
  await writeFile(join(cwd,'classifier-summary.json'),JSON.stringify({correction,task},null,2))
  console.log('Minimal classifier evidence: '+join(cwd,'classifier-summary.json'))
 }finally{
  for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key]
  Object.assign(process.env,previous)
 }
},180000)
