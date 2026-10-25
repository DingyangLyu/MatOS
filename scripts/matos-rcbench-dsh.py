#!/usr/bin/env python3
"""Portable, one-attempt DSH runner for a public ResearchClawBench task.

Uses the existing public projection and submission freezer. Scoring is separate.
"""
import argparse
import ast
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rcbench_public_base', ROOT/'scripts/matos-rcbench-public.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

def source_revision(root=ROOT):
    # A release snapshot has build metadata and intentionally no Git history.
    if (root / ".git").exists():
        return {
            "sourceCommit": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
            "sourceDirty": bool(subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True).strip()),
        }
    metadata = root / "build-info.json"
    info = json.loads(metadata.read_text()) if metadata.is_file() else {}
    return {"sourceCommit": info.get("commit", "unknown"), "sourceDirty": info.get("dirty", None)}

def command(workspace):
    return [str(ROOT/'scripts/matos-benchmark.sh'), 'run', '--execution', 'local',
            '--role', 'research-scientist', '--context-profile', 'full', '--model', 'deepseek-flash',
            (workspace/'INSTRUCTIONS.md').read_text()]

def prepare(args):
    tree = ast.parse(args.instructions_template.read_text())
    template = next(ast.literal_eval(node.value) for node in tree.body
                    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'INSTRUCTIONS_TEMPLATE' for t in node.targets))
    ws = args.workspace.resolve()
    base.project_task(args.task_root.resolve(), ws, template, str(ws))
    base.write_json(ws/'_meta.json', {'task_id':args.task_root.name,'run_id':ws.name,
                    'agent_name':'MatOS','model':'deepseek-flash','status':'prepared','timestamp':base.now()})
    base.write_json(ws/'_public-input-manifest.json', {'input_sha256':base.input_manifest(ws),
                    'prompt_sha256':base.digest(ws/'INSTRUCTIONS.md')})
    print(json.dumps({'prepared':str(ws)}))

def run(args):
    ws=args.workspace.resolve()
    manifest=json.loads((ws/'_public-input-manifest.json').read_text())
    if not all(base.verify_case_inputs(ws, manifest).values()):
        raise ValueError('Public inputs or instructions changed after preparation')
    with (ws/'.worker.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (ws/'_started.json').exists() or (ws/'_worker_result.json').exists():
            raise ValueError('Existing attempt: inspect it; choose a new workspace for a new run')
        started=time.monotonic()
        env={**os.environ,'MATOS_RUN_STREAM_STDOUT':'1','MATOS_RUN_STREAM_TOOL_EVENTS':'1','CUDA_VISIBLE_DEVICES':args.gpu}
        with (ws/'_agent_output.jsonl').open('w') as out, (ws/'_agent_stderr.log').open('w') as err:
            proc=subprocess.Popen(command(ws),cwd=ws,env=env,stdout=out,stderr=err,stdin=subprocess.DEVNULL,start_new_session=True)
            base.write_json(ws/'_started.json',{'at':base.now(),'pid':proc.pid,'engine':'deepseek-harness',
                'model':'deepseek-flash','role':'research-scientist','effort':'max','timeoutSeconds':args.timeout_seconds,
                **source_revision(),
                'launcherSha256':base.digest(ROOT/'scripts/matos-benchmark.sh')})
            timed_out=False
            try: code=proc.wait(timeout=args.timeout_seconds)
            except subprocess.TimeoutExpired:
                timed_out=True
                try: os.killpg(proc.pid,signal.SIGTERM)
                except ProcessLookupError: pass
                try: proc.wait(timeout=20)
                except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL);proc.wait()
                code=124
        result={'exitCode':code,'timedOut':timed_out,'durationSeconds':round(time.monotonic()-started,2),
                'reportPresent':(ws/'report/report.md').is_file(),'engine':'deepseek-harness','model':'deepseek-flash'}
        base.write_json(ws/'_worker_result.json',result)
        print(json.dumps(result))
        return code

def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='action',required=True)
    a=sub.add_parser('prepare');a.add_argument('--task-root',type=Path,required=True);a.add_argument('--instructions-template',type=Path,required=True);a.add_argument('--workspace',type=Path,required=True)
    a=sub.add_parser('run');a.add_argument('--workspace',type=Path,required=True);a.add_argument('--gpu',default='');a.add_argument('--timeout-seconds',type=int,default=43200)
    a=sub.add_parser('freeze');a.add_argument('--workspace',type=Path,required=True);a.add_argument('--output-root',type=Path,required=True)
    args=p.parse_args()
    if args.action=='prepare': prepare(args)
    elif args.action=='run': raise SystemExit(run(args))
    else:
        ws=args.workspace.resolve();dst=args.output_root.resolve()
        if dst==ws or ws in dst.parents: raise ValueError('Freeze outside the agent workspace')
        base.freeze_submission(dst,ws.name,ws)
        print(json.dumps({'frozen':str(dst/'submissions'/ws.name)}))

if __name__=='__main__': main()
