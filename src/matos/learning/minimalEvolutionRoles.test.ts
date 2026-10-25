
import {readFile} from 'node:fs/promises'
import {createDirectEditorIsolationWorkspace} from './directAssetEditorFilesystem'
import {expect,test} from 'bun:test'
import {resolve} from 'node:path'
import {runMatOSInit} from '../cli/init'
import {readMatOSProjectConfig,writeMatOSProjectConfig} from '../project'
import {loadMatOSAssetsFromRoot} from '../assets/loadAssets'
import {buildMatOSRunInvocation,buildMatOSRoleLaunchInvocation,cleanupMatOSRunInvocationMaterialization} from '../cli/run'
import {mkdtempInMatOSTmp} from '../runtime/tempDirs'

const root=resolve(import.meta.dir,'../../../distribution/benchmark-minimal/assets')
const hidden=['user-feedback-critic','direct-asset-editor','semantic-acceptance-judge','turn-feedback-classifier','self-evolution-worker']
test('minimal workspace contains the complete hidden evolution pipeline and only two selectable roles',async()=>{
 const assets=await loadMatOSAssetsFromRoot(root,{strict:true})
 expect(assets.filter(a=>a.type==='role' && a.metadata.hidden!==true).map(a=>a.id).sort()).toEqual(['compute','research-scientist'])
 for(const id of hidden){
  const role=assets.find(a=>a.type==='role'&&a.id===id)
  expect(role,id).toBeDefined()
  expect(role?.metadata.hidden,id).toBe(true)
  expect(role?.metadata.group,id).toBe('evolution')
 }
})
test('hidden evolution roles launch only internally, including pinned references',async()=>{
 const cwd=await mkdtempInMatOSTmp({prefix:'matos-minimal-hidden-'})
 const previous={...process.env}
 try{
  delete process.env.MATOS_INTERNAL_HIDDEN_RUN
  process.env.MATOS_BUNDLED_ASSET_ROOT=root
  process.env.MATOS_ASSETS_CWD=cwd
  await runMatOSInit({cwd,stdout:()=>{},stderr:()=>{}},{standalone:true,scopeRef:'user:local'})
  await writeMatOSProjectConfig(cwd,{...await readMatOSProjectConfig(cwd),assetRoots:[root],includeDefaultAssetRoots:false})
  for(const id of hidden){
   const role='role:'+id
   const inv=await buildMatOSRoleLaunchInvocation(role,cwd,[],{projectAccessMode:'internal-hidden'})
   await cleanupMatOSRunInvocationMaterialization(cwd,inv)
   const asset=inv.assets.find(a=>a.id===id&&a.type==='role')!
   for(const ref of [role,asset.canonicalKey]){
    await expect(buildMatOSRunInvocation(['--role',ref,'Hello'],cwd)).rejects.toThrow('reserved for internal')
    await expect(buildMatOSRoleLaunchInvocation(ref,cwd)).rejects.toThrow('reserved for internal')
   }
  }
  const compute=await buildMatOSRunInvocation(['--role','compute','Hello'],cwd)
  await cleanupMatOSRunInvocationMaterialization(cwd,compute)
  process.env.MATOS_INTERNAL_HIDDEN_RUN='1'
  const child=await buildMatOSRunInvocation(['--role','semantic-acceptance-judge','Review'],cwd)
  await cleanupMatOSRunInvocationMaterialization(cwd,child)
 }finally{
  for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k]
  Object.assign(process.env,previous)
 }
},60000)

test('minimal editor isolation copies only its runtime dependencies and retains scoped permissions',async()=>{
 const cwd=await mkdtempInMatOSTmp({prefix:'matos-minimal-editor-'})
 const isolation=await createDirectEditorIsolationWorkspace({
  cwd,scope:'project',scopeRef:'project:minimal-editor',runId:'minimal-editor',
  env:{...process.env,MATOS_BUNDLED_ASSET_ROOT:root},
 })
 try{
  const assets=await loadMatOSAssetsFromRoot(resolve(isolation.cwd,'matos-assets'))
  expect(assets.map(a=>a.type+':'+a.id).sort()).toEqual(['role:direct-asset-editor','skill:system-role','tool:files-core'])
  const editor=assets.find(a=>a.id==='direct-asset-editor')!
  expect(editor.metadata.hidden).toBe(true)
  expect(editor.runtime.permissionMode).toBe('dontAsk')
  expect(editor.runtime.disallowedTools).toContain('Bash')
  expect(editor.runtime.allowedTools).toContain('Read(/'+isolation.cwd+'/**)')
  const source=JSON.parse(await readFile(resolve(root,'packs/matos-benchmark/roles/direct-asset-editor/asset.json'),'utf8'))
  expect(source.runtime).toBeUndefined()
 }finally{await isolation.cleanup()}
},30000)
