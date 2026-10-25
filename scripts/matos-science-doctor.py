#!/usr/bin/env python3
"""Report real scientific dependency availability without installing packages."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

REQUIRED = {
    "mattools": ["numpy", "scipy", "ase", "pymatgen", "pymatgen.analysis.defects"],
    "sciagentgym": ["numpy", "scipy", "rdkit", "pymatgen", "PIL"],
    "researchclawbench": ["numpy", "scipy", "pandas", "matplotlib", "torch", "torch_geometric",
                         "rdkit", "ase", "mace", "pybamm", "pypsa", "highspy"],
}
PROBE = """
import importlib.util,importlib.metadata,json,sys
available={}
for name in json.loads(sys.argv[1]):
 try: available[name]=importlib.util.find_spec(name) is not None
 except (ImportError,ValueError): available[name]=False
versions={}
for name in ['pymatgen','pymatgen-analysis-defects']:
 try: versions[name]=importlib.metadata.version(name)
 except importlib.metadata.PackageNotFoundError: versions[name]=None
print(json.dumps({'python':sys.version.split()[0],'modules':available,'versions':versions}))
"""


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--profile", choices=[*REQUIRED, "all"], default="all")
    p.add_argument("--toolchain-root", type=Path, default=Path(os.environ.get("MATOS_TOOLCHAIN_ROOT", "/opt/matos-tools")))
    p.add_argument("--python", type=Path, action="append", default=[])
    p.add_argument("--model-root", type=Path)
    args = p.parse_args()
    names = sorted({name for modules in REQUIRED.values() for name in modules})
    roots = os.environ.get("MATOS_SYSTEM_CONDA_ENVS_PATH", str(args.toolchain_root / "conda/envs")).split(os.pathsep)
    candidates = args.python or sorted({e / "bin/python" for root in roots for e in Path(root).glob("*")})
    results = []
    for python in candidates:
        if not python.is_file() or not os.access(python, os.X_OK):
            continue
        try:
            run = subprocess.run([str(python), "-c", PROBE, json.dumps(names)],
                                 capture_output=True, text=True, timeout=20)
            row = json.loads(run.stdout) if run.returncode == 0 else {"error": run.stderr[-500:]}
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            row = {"error": str(error)[:500]}
        results.append({"executable": str(python), **row})
    checks = {}
    for profile in REQUIRED if args.profile == "all" else [args.profile]:
        if profile == "researchclawbench":
            missing = [name for name in REQUIRED[profile] if not any(r.get("modules", {}).get(name) for r in results)]
            checks[profile] = {"dependenciesAvailable": not missing, "missing": missing,
                               "note": "Tasks may use different interpreters. Inputs, model weights and GPU execution require separate task checks."}
        else:
            matching = [r for r in results if r.get("python", "").startswith("3.11.") and all(r.get("modules", {}).get(name) for name in REQUIRED[profile])]
            if profile == "mattools":
                matching = [r for r in matching if r.get("versions", {}).get("pymatgen") == "2024.8.9"
                            and r.get("versions", {}).get("pymatgen-analysis-defects") == "2024.7.19"]
            checks[profile] = {"dependenciesAvailable": bool(matching),
                               "matchingInterpreters": [r["executable"] for r in matching],
                               "requiredModules": REQUIRED[profile]}
    model_root = args.model_root or Path(os.environ.get("MATOS_MLIP_MODEL_ROOT", str(args.toolchain_root / "models/mlip")))
    report = {"ok": all(c["dependenciesAvailable"] for c in checks.values()), "checks": checks,
              "interpreters": results, "modelRoot": str(model_root), "modelRootExists": model_root.is_dir(),
              "scope": "Dependency discovery, not benchmark correctness or offline-data certification."}
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
