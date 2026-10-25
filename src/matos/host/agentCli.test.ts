import {test,expect} from 'bun:test'
import {Readable} from 'node:stream'
import {mkdtempInMatOSTmp} from '../runtime/tempDirs'
import {runMatOSAgentCli} from './agentCli'

test('already-cancelled native sessions exit without starting an inference',async()=>{
 const cwd=await mkdtempInMatOSTmp({prefix:'native-cancelled-'})
 const controller=new AbortController();controller.abort('cancelled')
 const result=await runMatOSAgentCli(['-p'],{cwd,env:{},stdin:Readable.from([]),stdout:()=>{},stderr:()=>{},signal:controller.signal})
 expect(result).toBe(143)
})
test('cancellation during asynchronous argument preparation is retained',async()=>{
 const cwd=await mkdtempInMatOSTmp({prefix:'native-cancel-preparation-'})
 const controller=new AbortController()
 const result=runMatOSAgentCli(['-p'],{cwd,env:{},stdin:Readable.from([]),stdout:()=>{},stderr:()=>{},signal:controller.signal})
 controller.abort('cancelled')
 expect(await result).toBe(143)
})
