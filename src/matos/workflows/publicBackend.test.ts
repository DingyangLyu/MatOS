import {test,expect} from 'bun:test'
import {mkdir,writeFile,readFile,access} from 'node:fs/promises'
import {join} from 'node:path'
import {mkdtempInMatOSTmp} from '../runtime/tempDirs'
import {startWorkflowRun,approveWorkflowNode} from './workflowRuntime'

test('public BACKEND executes an explicit local adapter only after approval and persists its result',async()=>{
 const cwd=await mkdtempInMatOSTmp({prefix:'public-backend-'})
 const folder=join(cwd,'.matos/assets/tools/local-calculator')
 await mkdir(folder,{recursive:true})
 await writeFile(join(cwd,'.matos/matos.json'),JSON.stringify({version:1,assetRoots:['assets'],includeDefaultAssetRoots:false}))
 await writeFile(join(folder,'asset.json'),JSON.stringify({schemaVersion:1,type:'tool',id:'local-calculator',version:'1.0.0',name:'Local calculator',entry:'tool.py',
  permissions:{shell:'disabled',network:'disabled',workspace:'read-write',secrets:[]},
  metadata:{kind:'external-tool',binding:'mcp__matos_asset__local_calculator',inputSchemaPath:'input.schema.json',
   executor:{type:'matos-python',runtime:'python3',entry:'tool.py',timeoutMs:30000,mcpName:'local_calculator'}}}))
 await writeFile(join(folder,'input.schema.json'),JSON.stringify({type:'object',properties:{values:{type:'array',items:{type:'number'}},output:{type:'string'}},required:['values','output']}))
 await writeFile(join(folder,'tool.py'),'import json,sys\nfrom pathlib import Path\nr=json.load(sys.stdin);p=r.get("input",r)\nresult={"sumSquares":sum(x*x for x in p["values"])}\nPath(p["output"]).write_text(json.dumps(result))\nprint(json.dumps(result))\n')
 const output=join(cwd,'calculation.json')
 const run=await startWorkflowRun({cwd,workspaceDir:cwd,workflowsDir:join(cwd,'runs'),workflowRef:'workflow:public-backend@1.0.0',parameters:{},
  definition:{schemaVersion:1,name:'Local backend',parameters:{},policy:{approvalMode:'bypass',defaultRisk:'low'},outputs:{},
   nodes:[{id:'calculate',type:'backend',dependsOn:[],backend:'local',tool:'tool:local-calculator',policy:{approval:'ask'},input:{values:[1,2,3],output}}]}})
 expect(run.status).toBe('waiting_approval')
 await expect(access(output)).rejects.toThrow()
 const approval=JSON.parse(await readFile(join(run.runDir,'approvals/calculate.json'),'utf8'))
 const completed=await approveWorkflowNode({runDir:run.runDir,nodeId:'calculate',approvedFingerprint:approval.actionFingerprint,response:{approvedBy:'local'}})
 expect(completed.status).toBe('completed')
 expect(JSON.parse(await readFile(output,'utf8'))).toEqual({sumSquares:14})
},30000)
