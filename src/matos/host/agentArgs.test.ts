import {test,expect} from 'bun:test'
import {parseMatOSAgentArgs} from './agentArgs'
test('default tool selection inherits the composed role surface',()=>{
 const args=parseMatOSAgentArgs(['-p','--tools','default','--permission-mode','bypassPermissions','hello'])
 expect(args.tools).toBeUndefined()
 expect(args.prompt).toBe('hello')
})
test('an explicitly empty tool surface stays empty for hidden judges',()=>{
 const args=parseMatOSAgentArgs(['-p','--tools','','--permission-mode','dontAsk','hello'])
 expect(args.tools).toEqual([])
})
test('explicit tool names remain a restriction',()=>{
 const args=parseMatOSAgentArgs(['-p','--tools','Read,Bash','--permission-mode','dontAsk','hello'])
 expect(args.tools).toEqual(['Read','Bash'])
})
