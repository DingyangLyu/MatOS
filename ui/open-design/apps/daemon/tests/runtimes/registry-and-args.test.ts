import {test,expect} from 'vitest';
import {AGENT_DEFS,getAgentDef} from '../../src/runtimes/registry.js';
test('the public workspace exposes only the native MatOS/DSH host',()=>{
 expect(AGENT_DEFS.map(def=>def.id)).toEqual(['matos']);
 expect(getAgentDef('matos')?.streamFormat).toBe('claude-stream-json');
 for(const id of ['claude','codex','opencode','unconfigured'])expect(getAgentDef(id)).toBeNull();
});
