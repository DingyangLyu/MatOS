#!/usr/bin/env python3
"""Portable file/configuration checks for benchmark projection; no model calls."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/"scripts"/file)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module
mt=load("public_mt","matos-mattools-agentic-bench.py")
sag=load("public_sag","matos-sciagentgym-bench.py")

class MatToolsProjection(unittest.TestCase):
    def test_project_public_question_and_keep_evaluation_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/"source"
            case=source/"src/question_segments/pymatgen_analysis_defects/test_example"
            case.mkdir(parents=True)
            (case/"question.txt").write_text("Return the requested property from the supplied input.")
            (case/"properties.json").write_text(json.dumps({"properties":{"value":"HIDDEN_REFERENCE"}}))
            (case/"new_unit_test.py").write_text("HIDDEN_EVALUATOR")
            tools=source/"src/tool_source_code";tools.mkdir();(tools/"guide.txt").write_text("PUBLIC_INTERFACE")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(mt.main(["prepare","--mattools-root",str(source),"--mattools-python",sys.executable,
                    "--case-id","test_example","--output-root",str(root/"runs"),"--run-id","case","--link-mode","copy","--json"]),0)
                self.assertEqual(mt.main(["run","--run-root",str(root/"runs/case"),"--runner","matos",
                    "--mattools-root",str(source),"--mattools-python",sys.executable,"--dry-run","--json"]),0)
            projected=root/"runs/case/cases/test_example"
            self.assertFalse((projected/"properties.json").exists())
            self.assertFalse((projected/"new_unit_test.py").exists())
            for path in projected.rglob("*"):
                if path.is_file():
                    self.assertNotIn("HIDDEN_REFERENCE",path.read_text())
                    self.assertNotIn("HIDDEN_EVALUATOR",path.read_text())
            command=json.loads((projected/"run-result.matos.json").read_text())["command"]
            self.assertEqual(Path(command[0]).name,"matos-benchmark.sh")
            self.assertEqual(command[command.index("--model")+1],"deepseek-flash")
    def test_only_matos_can_be_launched(self):
        result=subprocess.run([sys.executable,str(ROOT/"scripts/matos-mattools-agentic-bench.py"),
            "run","--runner","claude-code","--run-root","unused","--dry-run"],capture_output=True,text=True)
        self.assertEqual(result.returncode,2)

class SciAgentGymProjection(unittest.TestCase):
    def test_nested_reference_fields_are_removed_without_losing_public_inputs(self):
        source={"question":"PUBLIC_QUESTION","answer":"SECRET_ANSWER","tools":[{"name":"tool","tool_expected":"SECRET_EXPECTED"}],
                "metadata":{"solution_steps":["SECRET_STEPS"],"data":{"temperature":300}}}
        result=sag.strip_private_fields(source)
        self.assertEqual(result,{"question":"PUBLIC_QUESTION","tools":[{"name":"tool"}],
                                 "metadata":{"data":{"temperature":300}}})
    def test_benchmark_disables_mutable_learning(self):
        env=sag.benchmark_run_env()
        for key in ["MATOS_BENCHMARK_MODE","MATOS_DISABLE_ALWAYS_ON_LEARNING","MATOS_DISABLE_SELF_EVOLUTION"]:
            self.assertEqual(env[key],"1")

if __name__=="__main__":unittest.main()
