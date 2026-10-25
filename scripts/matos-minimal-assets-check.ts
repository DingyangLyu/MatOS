import {resolve} from 'node:path'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {loadMatOSAssetsFromRoot} from '../src/matos/assets/loadAssets.js'
import {buildMatOSAssetRegistry} from '../src/matos/assets/registry.js'
import {validateMatOSAssets} from '../src/matos/assets/validateAssets.js'
import {composeMatOSRoleRuntime} from '../src/matos/assets/runtimeComposition.js'
import {loadWorkflowAsset} from '../src/matos/workflows/loadWorkflow.js'
import {validateWorkflowDefinition} from '../src/matos/workflows/validateWorkflow.js'
const base=resolve(import.meta.dir,'../distribution/benchmark-minimal')
const profile=process.argv[3]??'benchmark'
if(!['benchmark','workspace'].includes(profile)) throw new Error('Unknown profile')
const manifest=JSON.parse(readFileSync(resolve(base,profile==='benchmark'?'manifest-benchmark.json':'manifest.json'),'utf8'))
const root=resolve(process.argv[2]??resolve(base,profile==='benchmark'?'benchmark-assets':'assets'))
const errors:string[]=[]
const hash=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex')
for(const file of manifest.files){
 try{const raw=readFileSync(resolve(root,file.path));if(raw.length!==file.bytes||hash(raw)!==file.sha256)errors.push('File mismatch: '+file.path)}
 catch{errors.push('Missing file: '+file.path)}
}
const assets=await loadMatOSAssetsFromRoot(root,{strict:true})
const registry=buildMatOSAssetRegistry(assets)
const expected=new Set(manifest.assets.map((x:{ref:string})=>x.ref))
if(assets.length!==manifest.assetCount)errors.push('Unexpected asset count')
// Pin the usage-based benchmark profile so an unreviewed asset change cannot pass silently.
const expectedProfiles:Record<string,{assets:number,types:Record<string,number>}>={
 benchmark:{assets:28,types:{skill:5,knowledge:1,data:2,tool:18,role:2}},
 workspace:{assets:37,types:{skill:7,knowledge:2,data:2,tool:18,role:7,workflow:1}},
}
const expectedProfile=expectedProfiles[profile]
if(manifest.assetCount!==expectedProfile.assets)errors.push('Unexpected manifest asset count: '+manifest.assetCount)
if(assets.length!==expectedProfile.assets)errors.push('Unexpected loaded asset count: '+assets.length)
const typeCounts:Record<string,number>={}
for(const a of assets)typeCounts[a.type]=(typeCounts[a.type]??0)+1
for(const type of new Set([...Object.keys(expectedProfile.types),...Object.keys(typeCounts)]))if((typeCounts[type]??0)!==(expectedProfile.types[type]??0))errors.push('Unexpected '+type+' count: '+(typeCounts[type]??0)+' (expected '+(expectedProfile.types[type]??0)+')')
for(const id of ['compute','research-scientist'])if(!registry.resolve('role:'+id))errors.push('Missing required role: '+id)
if(profile==='benchmark')for(const id of ['user-feedback-critic','direct-asset-editor','self-evolution-worker','turn-feedback-classifier','semantic-acceptance-judge'])if(registry.resolve('role:'+id))errors.push('Benchmark profile must not include hidden evolution role: '+id)
for(const a of assets)if(!expected.has(a.canonicalKey))errors.push('Non-allowlisted asset: '+a.canonicalKey)
for(const a of manifest.assets)if(!registry.resolve(a.ref))errors.push('Missing asset: '+a.ref)
errors.push(...(await validateMatOSAssets(assets,{requireToolMounts:true})).errors.map(e=>e.message))
// Manifest self-consistency alone cannot detect a removed runtime-only stage.
if(profile==='workspace'){
 for(const id of ['user-feedback-critic','direct-asset-editor','self-evolution-worker','turn-feedback-classifier','semantic-acceptance-judge']){
  const role=registry.resolve('role:'+id)
  if(!role || role.type!=='role' || role.metadata.hidden!==true || role.metadata.group!=='evolution')
   errors.push('Missing or non-hidden evolution role: '+id)
 }
}
const roles:Record<string,unknown>={}
for(const name of assets.filter(a=>a.type==='role').map(a=>a.id)){
 const p=await composeMatOSRoleRuntime(registry,'role:'+name,{contextProfile:'full'})
 for(const e of p.assetEvents)if(e.type==='skipped')errors.push(name+': '+e.assetKey+' '+e.reason)
 roles[name]={skills:p.skillDirs.length,externalTools:p.assetToolDirs.length,workflows:p.mountedWorkflowRefs.length}
}
for(const a of assets.filter(a=>a.type==='workflow')){
 const w=await loadWorkflowAsset(registry,a.canonicalKey)
 errors.push(...validateWorkflowDefinition(w.definition,{assetResolver:r=>registry.resolve(r)}).errors.map(e=>e.message))
}
console.log(JSON.stringify({ok:!errors.length,assets:assets.length,roles,errors},null,2))
if(errors.length)process.exitCode=1
