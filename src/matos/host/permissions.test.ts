import {test,expect} from 'bun:test'
import {mkdir,symlink,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {mkdtempInMatOSTmp} from '../runtime/tempDirs'
import {decideMatOSToolPermission,matOSProcessKillViolation,type MatOSToolPolicy} from './permissions'

test('hidden editor file permissions reject symlink escapes and permit scoped writes',async()=>{
 const root=await mkdtempInMatOSTmp({prefix:'dsh-permissions-'})
 const cwd=join(root,'work'),outside=join(root,'outside')
 await mkdir(cwd);await mkdir(outside);await writeFile(join(outside,'private.txt'),'outside')
 await symlink(outside,join(cwd,'link'))
 await symlink(cwd,join(root,'work-alias'))
 const policy:MatOSToolPolicy={mode:'dontAsk',cwd,additionalDirs:[],allowRules:['Write(/'+cwd+'/**)','Read(/'+cwd+'/**)'],denyRules:['Bash']}
 expect(decideMatOSToolPermission(policy,{name:'write',arguments:{file_path:join(cwd,'new.json')}}).behavior).toBe('allow')
 expect(decideMatOSToolPermission(policy,{name:'write',arguments:{file_path:join(cwd,'link/new.json')}}).behavior).toBe('deny')
 expect(decideMatOSToolPermission(policy,{name:'read',arguments:{file_path:join(cwd,'link/private.txt')}}).behavior).toBe('deny')
 const aliasPolicy={...policy,cwd:join(root,'work-alias'),allowRules:['Write(/'+join(root,'work-alias')+'/**)']}
 expect(decideMatOSToolPermission(aliasPolicy,{name:'write',arguments:{file_path:join(cwd,'new.json')}}).behavior).toBe('allow')
})
test('plan mode rejects mutating or unknown MCP tools while allowing native queries',()=>{
 const policy:MatOSToolPolicy={mode:'plan',cwd:process.cwd(),additionalDirs:[],allowRules:[],denyRules:[]}
 for(const name of ['bash','write','mcp__external__submit_job','mcp__matos_asset__workflow_start'])
  expect(decideMatOSToolPermission(policy,{name,arguments:{}}).behavior).toBe('deny')
 for(const name of ['read','web_search','mcp__matos_asset__asset_read','mcp__matos_asset__conda_environment_catalog'])
  expect(decideMatOSToolPermission(policy,{name,arguments:{}}).behavior).toBe('allow')
})

test('DSH host rejects process-name cleanup through common shell wrappers',()=>{
 for(const command of ['pkill -f python','/usr/bin/killall python','bash -lc "pkill -f worker"','env MODE=test pkill -f worker']){
  expect(matOSProcessKillViolation(command)).toContain('blocked process-name-wide')
 }
 for(const command of ['printf "pkill is prohibited"','python3 -c "print(14)"','kill -TERM 12345'])
  expect(matOSProcessKillViolation(command)).toBeUndefined()
 expect(matOSProcessKillViolation('x'.repeat(100001))).toContain('too long')
})
