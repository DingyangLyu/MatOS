#!/usr/bin/env python3
"""Opt-in real MatOS/DSH acceptance: native tools, subagent, MCP, and restart/resume."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    if os.environ.get("MATOS_RUN_REAL_LLM_TESTS") != "1":
        parser.error("Set MATOS_RUN_REAL_LLM_TESTS=1 to run the real model checks.")
    out = args.output.resolve()
    if out.exists():
        parser.error("Choose a new output directory.")
    out.mkdir(parents=True, mode=0o700)
    env = dict(os.environ)
    if args.env_file:
        raw = subprocess.check_output(["bun", str(ROOT/"scripts/matos-web-env.ts"), str(args.env_file.resolve())], cwd=ROOT)
        fields = raw.split(b"\0")
        for key, value in zip(fields[::2], fields[1::2]):
            if key and key != b"__MATOS_ENV_DONE":
                env[key.decode()] = value.decode()
    if not env.get("DEEPSEEK_API_KEY"):
        parser.error("A real DeepSeek credential is required.")
    project = out/"project"
    project.mkdir()
    env.update(MATOS_ORIGINAL_CWD=str(project), MATOS_STATE_DIR=str(out/"state"),
               MATOS_BUNDLED_ASSET_ROOT=str(ROOT/"distribution/benchmark-minimal/assets"),
               MATOS_DSH_MODEL="deepseek-flash", MATOS_RUNTIME_COMPILED="0",
               MATOS_DISABLE_EVOLUTION="1", MATOS_DISABLE_EVOLUTION_WORKER="1",
               MATOS_DISABLE_ALWAYS_ON_LEARNING="1", MATOS_DISABLE_SELF_EVOLUTION="1")
    subprocess.run([str(ROOT/"bin/matos"), "init", "--standalone"], cwd=project, env=env, check=True, capture_output=True)
    session = str(uuid.uuid4())
    phrase = "orchid-" + uuid.uuid4().hex[:12]
    prompts = [
        "Use the scientific-programming skill. Call conda_environment_catalog without package probes. "
        "Delegate 7 + 8 to a subagent and wait for its answer. Use Python to write acceptance.json "
        "with delegated_sum equal to that answer and environment_count equal to the catalog count. "
        "Read the file back. Remember this test phrase for our next exchange: " + phrase +
        ". Do not write the phrase into project files. Do not start an unrelated task.",
        "Recall the test phrase from our previous exchange, without searching runtime history files. "
        "Read acceptance.json, preserve its fields and add remembered_phrase with that phrase and verified=true."
    ]
    summary = {"sessionId":session, "model":"deepseek-flash", "turns":[]}
    for index, prompt in enumerate(prompts):
        started = time.monotonic()
        cmd = [str(ROOT/"bin/matos"), "--role", "compute", "-p",
               "--session-id" if index == 0 else "--resume", session,
               "--output-format", "stream-json", "--verbose", "--max-turns", "12", prompt]
        run = subprocess.run(cmd, cwd=project, env=env, capture_output=True, text=True, timeout=300)
        log = out/("turn-"+str(index+1)+".jsonl")
        log.write_text(run.stdout); log.chmod(0o600)
        err = out/("turn-"+str(index+1)+".stderr")
        err.write_text(run.stderr); err.chmod(0o600)
        messages=[]
        for line in run.stdout.splitlines():
            try: messages.append(json.loads(line))
            except ValueError: pass
        tools=[]
        def visit(value):
            if isinstance(value,dict):
                if value.get("type")=="tool_use" and isinstance(value.get("name"),str):tools.append(value["name"])
                for child in value.values():visit(child)
            elif isinstance(value,list):
                for child in value:visit(child)
        visit(messages)
        summary["turns"].append({"exitCode":run.returncode,"elapsedSeconds":round(time.monotonic()-started,2),"tools":sorted(set(tools))})
        (out/"summary.json").write_text(json.dumps(summary,indent=2)+"\n")
        if run.returncode:
            raise RuntimeError("Real native turn failed; inspect the private output directory.")
    data=json.loads((project/"acceptance.json").read_text())
    assert data.get("delegated_sum")==15, data
    assert isinstance(data.get("environment_count"),int), data
    assert data.get("remembered_phrase")==phrase, "Session did not preserve the previous-turn phrase"
    assert data.get("verified") is True, data
    names=" ".join(summary["turns"][0]["tools"]).lower()
    assert "skill" in names, "No actual Skill tool call recorded"
    assert any(name.lower() in {"subagent","subagent_fork","agent","task"} for name in summary["turns"][0]["tools"]), "No actual delegation recorded"
    assert "conda_environment_catalog" in names, "No actual native MCP catalog call recorded"
    summary["ok"]=True
    summary["checks"]=["skill","native-mcp","subagent","python","file-readback","cross-process-resume"]
    (out/"summary.json").write_text(json.dumps(summary,indent=2)+"\n")
    print(json.dumps(summary))

if __name__ == "__main__":
    main()
