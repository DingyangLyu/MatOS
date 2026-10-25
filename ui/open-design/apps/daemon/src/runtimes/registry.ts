import {matosAgentDef} from './defs/matos.js';
import type {RuntimeAgentDef} from './types.js';
// This distribution executes all conversations through the native MatOS/DSH host.
export const AGENT_DEFS: RuntimeAgentDef[] = [matosAgentDef];
export function getAgentDef(id:string):RuntimeAgentDef|null{return id==='matos'?matosAgentDef:null;}
