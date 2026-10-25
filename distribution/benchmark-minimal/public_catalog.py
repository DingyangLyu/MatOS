#!/usr/bin/env python3
"""Read-only public runtime discovery. No installation, queue or credential access."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

BINARIES = {
    "python": ["python3", "python"], "conda": ["conda"],
    "qe": ["pw.x"], "lammps": ["lmp", "lmp_serial"],
    "vasp": ["vasp_std"], "elk": ["elk"], "openfoam": ["foamRun"],
    "wannier90": ["wannier90.x"], "gw": ["yambo", "abinit"],
    "orca": ["orca"], "thermocalc": ["tc"], "xtb": ["xtb"],
    "crest": ["crest"], "gromacs": ["gmx"], "plumed": ["plumed"],
    "abacus": ["abacus"], "cp2k": ["cp2k.psmp", "cp2k.ssmp"],
    "qmcpack": ["qmcpack"],
}
IMPORTS = ["numpy", "scipy", "pymatgen", "ase", "rdkit", "torch",
           "torch_geometric", "sklearn", "mace", "pybamm", "pypsa"]
TOOL = Path(__file__).parent.name

def bounded(value, default, low, high):
    try: return min(high, max(low, float(value)))
    except (TypeError, ValueError): return default

def env_roots(payload):
    roots = []
    if payload.get("includeSystem", True):
        roots.extend(os.environ.get("MATOS_SYSTEM_CONDA_ENVS_PATH",
                     str(Path(os.environ.get("MATOS_TOOLCHAIN_ROOT", "/opt/matos-tools"))/"conda/envs")).split(os.pathsep))
    if payload.get("includeUser", True):
        roots.extend(os.environ.get("MATOS_USER_CONDA_ENVS_PATH",
                     str(Path.home()/".conda/envs")).split(os.pathsep))
    return list(dict.fromkeys(Path(p).expanduser() for p in roots if p))

def environments(payload):
    out = []
    limit = int(bounded(payload.get("limit"), 40, 1, 80))
    deadline = time.monotonic() + 20
    imports = payload.get("imports") or IMPORTS
    imports = [s for s in imports if isinstance(s,str) and re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*",s)][:32]
    for root in env_roots(payload):
        if not root.is_dir(): continue
        for env in sorted(root.iterdir()):
            if len(out) >= limit: break
            python = next((p for p in [env/"bin/python",env/"bin/python3"] if p.is_file() and os.access(p,os.X_OK)),None)
            if python is None: continue
            item = {"name":env.name,"path":str(env),"python":str(python),
                    "pythonExecutable":str(python),"available":True,"packageProbe":"not-requested"}
            if payload.get("probePackages"):
                remaining=deadline-time.monotonic()
                if remaining <= 0:
                    item["packageProbe"]="budget-exhausted"
                else:
                    script="import importlib.util,json,sys\nout={}\nfor name in json.loads(sys.argv[1]):\n try: out[name]=importlib.util.find_spec(name) is not None\n except (ImportError,ValueError,ModuleNotFoundError): out[name]=False\nprint(json.dumps(out))"
                    try:
                        proc=subprocess.run([str(python),"-c",script,json.dumps(imports)],capture_output=True,text=True,
                            timeout=min(remaining,bounded(payload.get("timeoutSeconds"),8,1,30)))
                        if proc.returncode==0:
                            item.update(packages=json.loads(proc.stdout),packageProbe="complete")
                        else: item.update(packageProbe="failed",exitCode=proc.returncode)
                    except (subprocess.TimeoutExpired,ValueError,OSError):
                        item["packageProbe"]="failed-or-timeout"
            out.append(item)
    return out

def tool_paths(payload):
    names=payload.get("checks") or payload.get("tools") or ["python","conda","qe","lammps"]
    root=Path(payload.get("toolchainRoot") or os.environ.get("MATOS_TOOLCHAIN_ROOT","/opt/matos-tools"))
    found=[]
    for name in names:
        if name=="gpu": continue
        if name=="openmm":
            available=importlib.util.find_spec("openmm") is not None
            found.append({"name":name,"available":available,"probe":"current-interpreter-module-spec"})
            continue
        candidates=BINARIES.get(name,[])
        executable=None
        for binary in candidates:
            paths=[root/"bin"/binary,root/name/"bin"/binary]
            located=shutil.which(binary)
            if located: paths.append(Path(located))
            executable=next((str(p) for p in paths if p.is_file() and os.access(p,os.X_OK)),None)
            if executable: break
        found.append({"name":name,"executable":executable,"available":executable is not None,
                      "probe":"executable-presence-only","scientificallyValidated":False})
    return found

def gpu_status():
    visible=os.environ.get("CUDA_VISIBLE_DEVICES")
    return {"visibleDevices":visible,"nvidiaSmi":shutil.which("nvidia-smi"),
            "status":"operator-assignment-required" if visible is None else "visibility-configured",
            "note":"Discovery does not reserve a GPU or verify a calculation. Respect assigned visibility."}

def main():
    raw=json.load(sys.stdin);payload=raw.get("input",raw) if isinstance(raw,dict) else {}
    if not isinstance(payload,dict): raise ValueError("input must be an object")
    result={"ok":True,"edition":"benchmark-minimal","readOnly":True}
    if TOOL=="conda-environment-catalog":
        result["environments"]=environments(payload)
        if payload.get("includeSourceRouting",True):
            result["packageSources"]={"pipIndexUrl":"configured externally" if os.environ.get("PIP_INDEX_URL") else "https://pypi.org/simple/"}
    elif TOOL=="atomistic-toolchain-catalog":
        result["tools"]=tool_paths(payload)
    elif TOOL=="local-toolchain-preflight":
        result["tools"]=tool_paths(payload)
        if "gpu" in (payload.get("checks") or payload.get("tools") or []):result["gpu"]=gpu_status()
    elif TOOL=="materials-runtime-inventory":
        if payload.get("includeConda",True):result["environments"]=environments({**payload,"probePackages":False})
        if payload.get("includeToolchain",True):result["tools"]=tool_paths(payload)
        result["modelCatalog"]="Use mlip_model_catalog for operator-installed model files."
        result["scope"]="Local interpreters and executable presence only; no private datasets or source library."
    else: raise ValueError("Unknown catalog asset")
    if payload.get("includeGpu"):result["gpu"]=gpu_status()
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=="__main__":
    try: main()
    except (ValueError,OSError,TypeError) as error:
        print(json.dumps({"ok":False,"error":str(error)}));sys.exit(1)
