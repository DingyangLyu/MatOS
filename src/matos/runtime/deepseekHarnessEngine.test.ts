import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'bun:test'
import { disposeMatOSDeepSeekHarnessPool, executeMatOSDeepSeekHarnessTurn, matOSProjectionToDeepSeekMcpConfig } from './deepseekHarnessEngine.js'

test('native MCP credentials reach the private process configuration', () => {
  const credential = 'synthetic-mcp-credential';
  const encoded = matOSProjectionToDeepSeekMcpConfig([JSON.stringify({ mcpServers: {
    authenticated: { command: 'node', args: ['server.js'], env: {
      API_KEY: credential, SERVICE_TOKEN: '${SERVICE_TOKEN}', REGION: 'private', INVALID: 123,
    } },
  } })]);
  expect(JSON.parse(encoded!)[0].env).toEqual({ API_KEY: credential, SERVICE_TOKEN: '${SERVICE_TOKEN}', REGION: 'private' });
});

test('pre-aborted native turn does not start a runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-aborted-'))
  try {
    const abort = new AbortController()
    abort.abort(new Error('cancelled before spawn'))
    await expect(executeMatOSDeepSeekHarnessTurn({ cwd: root, env: {}, matosSessionId:'pre-aborted', prompt:'never sent', signal:abort.signal })).rejects.toThrow('cancelled before spawn')
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('missing runtime executable fails promptly with no orphaned session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-missing-'))
  try {
    const env = { HOME:root, MATOS_RUNTIME_DATA_DIR:join(root,'runtime'), MATOS_DSH_HOME:join(root,'dsh'), MATOS_DSH_BIN:join(root,'not-installed') }
    for (let attempt=0; attempt<2; attempt++) {
      const result = await executeMatOSDeepSeekHarnessTurn({cwd:root,env,matosSessionId:'missing',prompt:'never sent',timeoutMs:3000})
      expect(result.exitCode).toBe(1)
      expect(result.error).toContain('ENOENT')
    }
  } finally { await disposeMatOSDeepSeekHarnessPool(); await rm(root,{recursive:true,force:true}) }
}, 10000)

const real = process.env.MATOS_RUN_REAL_LLM_TESTS === '1' && Boolean(process.env.DEEPSEEK_API_KEY)
test.skipIf(!real)('real DSH preserves user content and history across process restart without tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-native-'))
  const cwd = join(root,'workspace')
  await mkdir(cwd)
  const preparedProfile = process.env.MATOS_DSH_TEST_PROFILE_TEMPLATE
  if (preparedProfile) await cp(preparedProfile, join(root, 'dsh', 'profiles'), { recursive: true, verbatimSymlinks: true })
  const env = { PATH:process.env.PATH, HOME:root, DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY, MATOS_DSH_HOME:join(root,'dsh'), MATOS_RUNTIME_DATA_DIR:join(root,'runtime'), MATOS_DISABLE_EVOLUTION:'1', npm_config_cache:process.env.npm_config_cache, npm_config_registry:process.env.npm_config_registry, MATOS_DSH_EXEC_BIN:process.env.MATOS_DSH_EXEC_BIN, MATOS_DSH_PNPM_BIN:process.env.MATOS_DSH_PNPM_BIN, MATOS_DSH_MODEL:process.env.MATOS_DSH_MODEL, MATOS_DSH_OFFLINE:preparedProfile ? '1' : '0' }
  const base = {cwd,env,matosSessionId:'real-conversation',noTools:true,permissionMode:'read-only' as const,timeoutMs:120000,maxTokens:1024}
  try {
    const first=await executeMatOSDeepSeekHarnessTurn({...base,prompt:'Remember XQ7J9. Reply SAVED.'})
    expect(first.exitCode).toBe(0)
    const second=await executeMatOSDeepSeekHarnessTurn({...base,prompt:'Reply with the remembered code only.'})
    expect(second.exitCode).toBe(0)
    expect(second.finalText.trim()).toBe('XQ7J9')
    expect(second.notifications.some(n=>(n.params.event as {type?:string})?.type==='tool/call')).toBe(false)
  } finally { await disposeMatOSDeepSeekHarnessPool(); await rm(root,{recursive:true,force:true}) }
},270000)
