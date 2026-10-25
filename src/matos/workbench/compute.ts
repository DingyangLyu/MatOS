import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MatOSWorkbenchContext } from './types.js'
const exec=promisify(execFile)
export type MatOSWorkbenchComputeOptions=MatOSWorkbenchContext & {targetGpus?:string;demandMode?:string;scriptRunner?:unknown}
export async function statusMatOSWorkbenchCompute(input:MatOSWorkbenchComputeOptions){
 const {stdout}=await exec('nvidia-smi',['--query-compute-apps=pid,process_name,used_memory','--format=csv,noheader,nounits'],{timeout:5000,env:{...process.env,...input.env}})
 const processes=stdout.trim().split('\n').filter(Boolean).map(line=>{
  const [pid,command,memory]=line.split(',').map(x=>x.trim())
  return {pid:Number(pid),command,memoryUsedMiB:Number(memory),ownerKind:'local',actionable:false}
 })
 return {kind:'compute-status',status:'ok',gpu:{processes},actions:[]}
}
export async function checkMatOSWorkbenchCompute(_input:MatOSWorkbenchComputeOptions):Promise<never>{
 throw new Error('GPU allocation and fleet conflict checks are not part of the single-user edition.')
}
