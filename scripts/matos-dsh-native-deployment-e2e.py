#!/usr/bin/env python3
"""Opt-in real DSH deployment regression; run on a host with isolated output."""
import os,sys,json,subprocess,uuid,time,argparse
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--bundle',type=Path)
args=parser.parse_args()
if os.environ.get('MATOS_RUN_REAL_LLM_TESTS')!='1' or not os.environ.get('DEEPSEEK_API_KEY'):
 print(json.dumps({'skipped':True,'reason':'Requires MATOS_RUN_REAL_LLM_TESTS=1 and DEEPSEEK_API_KEY'}));sys.exit(0)
root=args.output.resolve()
if root.exists():raise SystemExit('Choose a new isolated --output directory')
root.mkdir(parents=True,mode=0o700)
work=root/'workspace';work.mkdir(exist_ok=True)
bundle=(args.bundle or Path(subprocess.check_output([sys.executable,str(repo/'scripts/matos-dsh-runtime.py'),'path'],text=True).strip())).resolve()
profile=root/'dsh/profiles'
env=dict(os.environ)
env.update(NODE_ENV='production',MATOS_AGENT_HOME=str(root/'native-config'),MATOS_MODE='1',MATOS_ROLE_REF='role:compute',MATOS_DISABLE_EVOLUTION='1',MATOS_BENCHMARK_MODE='1',MATOS_RUNTIME_COMPILED='0',MATOS_RUNTIME_DATA_DIR=str(root/'runtime'),MATOS_RUNTIME_MATERIALIZATION_DIR=str(root/'materialization'),MATOS_BUNDLED_ASSET_ROOT=str(repo/'matos-assets'),MATOS_ASSET_ROOT=str(root/'assets'),MATOS_DSH_HOME=str(root/'dsh'),MATOS_DSH_OFFLINE='1',MATOS_DSH_EXEC_BIN=str(bundle/'bin/dsh'),MATOS_DSH_PNPM_BIN=str(bundle/'pnpm/bin/pnpm.cjs'),MATOS_DSH_PROFILE_TEMPLATE=str(bundle/'profiles'),MATOS_DSH_MODEL='deepseek-flash',MATOS_DSH_EFFORT='low',MATOS_DSH_TIMEOUT_MS='120000',MATOS_PROJECT_CWD=str(work),MATOS_ORIGINAL_CWD=str(work))
session=str(uuid.uuid4())
def run(name,prompt,tools,resume=False):
 args=[str(repo/'bin/matos'),'-p','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--verbose','--permission-mode','bypassPermissions','--dangerously-skip-permissions','--effort','low','--model','deepseek-flash','--max-turns','12','--tools',tools,'--resume' if resume else '--session-id',session]
 msg={'type':'user','session_id':session,'parent_tool_use_id':None,'message':{'role':'user','content':[{'type':'text','text':prompt}]}}
 start=time.time()
 try:
  proc=subprocess.run(args,cwd=work,env=env,input=json.dumps(msg)+'\n',text=True,capture_output=True,timeout=240)
  (root/(name+'.stdout.jsonl')).write_text(proc.stdout)
  (root/(name+'.stderr.log')).write_text(proc.stderr)
  events=[]
  for line in proc.stdout.splitlines():
   try: events.append(json.loads(line))
   except ValueError: pass
  blocks=[b for e in events for b in (e.get('message',{}).get('content',[]) if isinstance(e.get('message',{}).get('content'),list) else [])]
  calls=[{'name':b.get('name'),'id':b.get('id')} for b in blocks if b.get('type')=='tool_use']
  results=[{'id':b.get('tool_use_id'),'is_error':b.get('is_error',False),'content':str(b.get('content',''))[:2000]} for b in blocks if b.get('type')=='tool_result']
  finals=[{k:e.get(k) for k in ['subtype','is_error','result','session_id']} for e in events if e.get('type')=='result']
  out={'name':name,'seconds':round(time.time()-start,2),'exit':proc.returncode,'calls':calls,'toolResults':results,'finals':finals}
 except subprocess.TimeoutExpired: out={'name':name,'error':'outer timeout'}
 (root/(name+'.summary.json')).write_text(json.dumps(out,ensure_ascii=False,indent=2))
 print(json.dumps(out,ensure_ascii=False),flush=True)
 return out
marker='DSH_DEPLOY_'+uuid.uuid4().hex[:10]
(work/'input.txt').write_text(marker+'\n')
a=run('read-write','Read input.txt with read, then use write to create copied.txt containing exactly the same marker and newline. Remember the marker. Reply COPIED after successful tool results. Do not use other tools.','Read,Write')
a['fileBytesCorrect']=(work/'copied.txt').exists() and (work/'copied.txt').read_text()==marker+'\n'
b=run('resume','What exact marker did you copy in the previous turn? Reply only the marker. Do not call tools.','',True)
b['remembered']=any(marker in str(x.get('result')) for x in b.get('finals',[]))
session=str(uuid.uuid4())
c=run('native-subagent', 'First use todo_write to record one in-progress item: Verify delegation. Then use subagent exactly once with a task to calculate 7*8, reply CHILD_56, and report to its parent if needed. Use send_message once to that child asking it to include CHILD_56 in its report. Wait for its successful completion, then mark the todo completed with todo_write and reply PARENT_OK. If a tool is rejected, report the exact error. Do not solve the child task yourself.', 'Agent,SendMessage,TaskStop,TodoWrite')
session=str(uuid.uuid4())
old_marker='SECOND_SESSION_'+uuid.uuid4().hex[:10]
d=run('second-session-start','Remember the exact code '+old_marker+'. Reply SAVED only.','')
e=run('second-session-resume','What exact code did I ask you to remember in the previous turn? Reply only that code.','',True)
f=run('second-session-repeat','Repeat the same remembered code again, without any additional words.','',True)
checks=[a,b,c,d,e,f]
summary={'sourceDirectory':str(repo),'model':'deepseek-flash','checks':checks,'secondSessionStartPassed':d.get('exit')==0 and any('SAVED' in str(v.get('result')) for v in d.get('finals',[])),'readWritePassed':a['fileBytesCorrect'],'resumePassed':b['remembered'],'secondSessionResumePassed':any(old_marker in str(v.get('result')) for v in e.get('finals',[])),'secondSessionRepeatPassed':any(old_marker in str(v.get('result')) for v in f.get('finals',[])),'delegationPassed':any(v.get('name')=='subagent' for v in c.get('calls',[])) and not any(v['is_error'] for v in c.get('toolResults',[])) and any('PARENT_OK' in str(v.get('result')) for v in c.get('finals',[]))}
(root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in summary.items() if k!='checks'}),flush=True)
if not all(summary[k] for k in ['secondSessionStartPassed','readWritePassed','resumePassed','secondSessionResumePassed','secondSessionRepeatPassed','delegationPassed']):sys.exit(1)
