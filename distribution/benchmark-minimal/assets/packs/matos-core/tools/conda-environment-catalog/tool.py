#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from typing import Any


DEFAULT_SYSTEM_ENV_ROOTS = [
    "/opt/matos-tools/conda/envs",
]
DEFAULT_USER_ENV_ROOTS = ["/workspace/caches/conda/envs"]
CONTAINER_TOOLCHAIN_ROOT = "/opt/matos-tools"
DEFAULT_IMPORTS = [
    "torch",
    "ase",
    "pymatgen",
    "mace",
    "chgnet",
    "sevenn",
    "torch_geometric",
    "torch_scatter",
    "torch_sparse",
    "mattersim",
    "orb_models",
    "fairchem",
    "torch_sim",
    "m3gnet",
    "matgl",
    "nequip",
    "allegro",
    "schnetpack",
    "torchmdnet",
    "alignn",
    "jarvis",
    "cantera",
    "atomate2",
    "jobflow",
    "jobflow_remote",
    "smol",
    "pycalphad",
    "tc_python",
    "rdkit",
    "deepchem",
    "shap",
    "mastml",
    "matminer",
    "modnet",
    "qsprpred",
    "scaffviz",
    "papyrus_scripts",
    "pubchempy",
    "chembl_webresource_client",
    "MDAnalysis",
    "prolif",
    "parmed",
    "openbabel",
    "vina",
    "meeko",
    "pdbfixer",
    "openmm",
    "scine_utilities",
    "scine_readuct",
    "nmrglue",
    "nmrsim",
    "mattergen",
    "wannierberri",
    "z2pack",
    "gpaw",
    "yambopy",
    "abipy",
    "pyxtal",
    "doped",
    "pybamm",
    "pybop",
    "bpx",
    "liionpack",
    "openpnm",
    "pyscipopt",
    "phonopy",
    "phono3py",
    "amset",
    "dolfinx",
    "ufl",
    "ffcx",
    "basix",
    "petsc4py",
    "mpi4py",
    "gmsh",
    "meshio",
    "BoltzTraP2",
    "numpy",
    "pandas",
    "scipy",
    "sklearn",
    "joblib",
]
PACKAGE_NAMES = {
    "mace": "mace-torch",
    "sevenn": "sevenn",
    "torch_geometric": "torch-geometric",
    "torch_scatter": "torch-scatter",
    "torch_sparse": "torch-sparse",
    "orb_models": "orb-models",
    "torch_sim": "torch-sim-atomistic",
    "allegro": "nequip-allegro",
    "torchmdnet": "torchmd-net",
    "jarvis": "jarvis-tools",
    "cantera": "cantera",
    "jobflow_remote": "jobflow-remote",
    "tc_python": "tc-python",
    "pdbfixer": "pdbfixer",
    "scine_utilities": "scine-utilities-python",
    "scine_readuct": "scine-readuct-python",
    "chembl_webresource_client": "chembl-webresource-client",
    "MDAnalysis": "MDAnalysis",
    "deepchem": "deepchem",
    "mastml": "mastml",
    "matminer": "matminer",
    "modnet": "modnet",
    "qsprpred": "qsprpred",
    "scaffviz": "papyrus-scaffold-visualizer",
    "papyrus_scripts": "papyrus-scripts",
    "prolif": "prolif",
    "pubchempy": "PubChemPy",
    "openbabel": "openbabel-wheel",
    "wannierberri": "wannierberri",
    "z2pack": "z2pack",
    "gpaw": "gpaw",
    "yambopy": "yambopy",
    "abipy": "abipy",
    "doped": "doped",
    "pybamm": "pybamm",
    "pybop": "pybop",
    "bpx": "bpx",
    "liionpack": "liionpack",
    "openpnm": "openpnm",
    "pyscipopt": "PySCIPOpt",
    "phonopy": "phonopy",
    "phono3py": "phono3py",
    "amset": "amset",
    "dolfinx": "fenics-dolfinx",
    "ufl": "fenics-ufl",
    "ffcx": "fenics-ffcx",
    "basix": "fenics-basix",
    "petsc4py": "petsc4py",
    "mpi4py": "mpi4py",
    "gmsh": "python-gmsh",
    "meshio": "meshio",
    "BoltzTraP2": "BoltzTraP2",
    "sklearn": "scikit-learn",
}
ENV_EXECUTABLE_PROBES = [
    "abacus",
    "cp2k",
    "cp2k.psmp",
    "cp2k.ssmp",
    "cp2k.popt",
    "gmx",
    "ck2yaml",
    "blockMesh",
    "icoFoam",
    "simpleFoam",
    "pimpleFoam",
    "pisoFoam",
    "interFoam",
    "vina",
    "obabel",
    "orca",
    "raspa3",
    "xtb",
    "crest",
    "wannier90.x",
    "postw90.x",
    "pw2wannier90.x",
    "wannier_ham.x",
    "wannier_plot.x",
    "yambo",
    "ypp",
    "p2y",
    "abinit",
    "gpaw",
    "epsilon.cplx.x",
    "sigma.cplx.x",
    "kernel.cplx.x",
    "absorption.cplx.x",
    "wstat.x",
    "wfreq.x",
    "westpp.x",
    "antechamber",
    "tleap",
    "MMPBSA.py",
    "scip",
    "soplex",
    "gcg",
    "phonopy",
    "phono3py",
    "amset",
    "gmsh",
    "mpirun",
    "mpiexec",
]
RECOMMENDED = {
    "tabular-ml": "/opt/matos-tools/conda/envs/matos-tabular-ml-py312/bin/python",
    "scikit-learn": "/opt/matos-tools/conda/envs/matos-tabular-ml-py312/bin/python",
    "mace": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "chgnet": "/opt/matos-tools/conda/envs/matos-mlip-py311/bin/python",
    "sevennet": "/opt/matos-tools/conda/envs/matos-mlip-py311/bin/python",
    "mattersim": "/opt/matos-tools/conda/envs/matos-mlip-py312/bin/python",
    "orb": "/opt/matos-tools/conda/envs/matos-mlip-py312/bin/python",
    "fairchem": "/opt/matos-tools/conda/envs/matos-mlip-py312/bin/python",
    "matgl": "/opt/matos-tools/conda/envs/matos-mlip-gnn-py311/bin/python",
    "m3gnet": "/opt/matos-tools/conda/envs/matos-m3gnet-py311/bin/python",
    "nequip": "/opt/matos-tools/conda/envs/matos-mlip-gnn-py311/bin/python",
    "allegro": "/opt/matos-tools/conda/envs/matos-mlip-gnn-py311/bin/python",
    "schnetpack": "/opt/matos-tools/conda/envs/matos-mlip-gnn-py311/bin/python",
    "torchmd-net": "/opt/matos-tools/conda/envs/matos-mlip-gnn-py311/bin/python",
    "alignn": "/opt/matos-tools/conda/envs/matos-mlip-gnn-py311/bin/python",
    "cantera": "/opt/matos-tools/conda/envs/matos-combustion-py312/bin/python",
    "ck2yaml": "/opt/matos-tools/conda/envs/matos-combustion-py312/bin/ck2yaml",
    "combustion": "/opt/matos-tools/conda/envs/matos-combustion-py312/bin/python",
    "cp2k": "/opt/matos-tools/conda/envs/matos-cp2k/bin/cp2k",
    "cp2k.psmp": "/opt/matos-tools/conda/envs/matos-cp2k/bin/cp2k.psmp",
    "abacus": "/opt/matos-tools/conda/envs/matos-abacus/bin/abacus",
    "openfoam": "/opt/matos-tools/bin/openfoam",
    "blockMesh": "/opt/matos-tools/bin/blockMesh",
    "icoFoam": "/opt/matos-tools/bin/icoFoam",
    "simpleFoam": "/opt/matos-tools/bin/simpleFoam",
    "mlip-benchmark": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "mace-finetune": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "mace-les": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "mace-les-train": "/opt/matos-tools/mace-les/bin/mace-les-run-train",
    "chengucb-mace-les": "/opt/matos-tools/mace-les/bin/mace-les-run-train",
    "matgl-finetune": "/opt/matos-tools/conda/envs/matos-mlip-gnn-py311/bin/python",
    "fairchem-finetune": "/opt/matos-tools/conda/envs/matos-mlip-py312/bin/python",
    "atomate2": "/opt/matos-tools/conda/envs/matos-atomate2-py310/bin/python",
    "jobflow": "/opt/matos-tools/conda/envs/matos-atomate2-py310/bin/python",
    "smol": "/opt/matos-tools/conda/envs/matos-smol-py310/bin/python",
    "drugdisc": "/opt/matos-tools/conda/envs/matos-drugdisc-py311/bin/python",
    "scienceagentbench-l5": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "hiscibench-l5": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "mattools": "/opt/matos-tools/conda/envs/matos-mattools-py311/bin/python",
    "mattoolbench": "/opt/matos-tools/conda/envs/matos-mattools-py311/bin/python",
    "mattools-benchmark": "/opt/matos-tools/conda/envs/matos-mattools-py311/bin/python",
    "chemical-benchmark": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "computational-chemistry-benchmark": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "papyrus": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "papyrus-scripts": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "qsprpred": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "scaffviz": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "deepchem-benchmark": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "modnet-benchmark": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "matminer-benchmark": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "mastml-benchmark": "/opt/matos-tools/conda/envs/matos-scienceagentbench-l5-py311/bin/python",
    "vina": "/opt/matos-tools/conda/envs/matos-drugdisc-py311/bin/vina",
    "meeko": "/opt/matos-tools/conda/envs/matos-drugdisc-py311/bin/python",
    "rdkit": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "pubchem": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "chembl": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "admet": "/opt/matos-tools/conda/envs/matos-drugdisc-py311/bin/python",
    "toxicity": "/opt/matos-tools/conda/envs/matos-drugdisc-py311/bin/python",
    "retrosynthesis": "/opt/matos-tools/conda/envs/matos-drugdisc-py311/bin/python",
    "xrd": "/opt/matos-tools/conda/envs/matos-xrd-py311/bin/python",
    "gsasii": "/opt/matos-tools/conda/envs/matos-xrd-py311/bin/python",
    "bbo-rietveld": "/opt/matos-tools/conda/envs/matos-xrd-py311/bin/python",
    "rietveld": "/opt/matos-tools/conda/envs/matos-xrd-py311/bin/python",
    "optuna": "/opt/matos-tools/conda/envs/matos-xrd-py311/bin/python",
    "calphad": "/opt/matos-tools/conda/envs/matos-calphad-py310/bin/python",
    "pycalphad": "/opt/matos-tools/conda/envs/matos-calphad-py310/bin/python",
    "nmr": "/opt/matos-tools/conda/envs/matos-nmr-py311/bin/python",
    "orca": "/opt/matos-tools/bin/orca",
    "orca-python": "/opt/matos-tools/conda/envs/matos-orca-py311/bin/python",
    "phasefield": "/opt/matos-tools/conda/envs/matos-phasefield-py310/bin/python",
    "fenics": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "fenicsx": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "dolfinx": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "ufl": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "ffcx": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "basix": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "petsc4py": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "mpi4py": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "gmsh": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/gmsh",
    "meshio": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "fem": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "finite-element": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "pde-solver": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
    "bayesian-optimization": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "property-predictor": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "gcmc": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "mof": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "optimade": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
    "pyvista": "/opt/matos-tools/conda/envs/matos-pyvista-py311/bin/python",
    "vtk": "/opt/matos-tools/conda/envs/matos-pyvista-py311/bin/python",
    "mesh-visualization": "/opt/matos-tools/conda/envs/matos-pyvista-py311/bin/python",
    "scientific-3d-visualization": "/opt/matos-tools/conda/envs/matos-pyvista-py311/bin/python",
    "phonopy": "/opt/matos-tools/conda/envs/matos-atomistic-base-py311/bin/python",
    "phono3py": "/opt/matos-tools/conda/envs/matos-atomistic-base-py311/bin/python",
    "phonon-thermal-transport": "/opt/matos-tools/conda/envs/matos-atomistic-base-py311/bin/python",
    "amset": "/opt/matos-tools/conda/envs/matos-atomistic-base-py311/bin/python",
    "electronic-transport": "/opt/matos-tools/conda/envs/matos-atomistic-base-py311/bin/python",
    "thermoelectric-transport": "/opt/matos-tools/conda/envs/matos-atomistic-base-py311/bin/python",
    "wannier90": "/opt/matos-tools/bin/wannier90.x",
    "postw90": "/opt/matos-tools/bin/postw90.x",
    "pyxtal": "/opt/matos-tools/conda/envs/matos-pyxtal-py311/bin/python",
    "crystal-generation": "/opt/matos-tools/conda/envs/matos-pyxtal-py311/bin/python",
    "random-structure-search": "/opt/matos-tools/conda/envs/matos-pyxtal-py311/bin/python",
    "doped": "/opt/matos-tools/conda/envs/matos-defects-py311/bin/python",
    "battery-electrochem": "/opt/matos-tools/conda/envs/matos-battery-electrochem-py311/bin/python",
    "pybamm": "/opt/matos-tools/conda/envs/matos-battery-electrochem-py311/bin/python",
    "pybop": "/opt/matos-tools/conda/envs/matos-battery-electrochem-py311/bin/python",
    "bpx": "/opt/matos-tools/conda/envs/matos-battery-electrochem-py311/bin/python",
    "liionpack": "/opt/matos-tools/conda/envs/matos-battery-electrochem-py311/bin/python",
    "openpnm": "/opt/matos-tools/conda/envs/matos-battery-electrochem-py311/bin/python",
    "scip": "/opt/matos-tools/bin/scip",
    "soplex": "/opt/matos-tools/bin/soplex",
    "gcg": "/opt/matos-tools/bin/gcg",
    "pyscipopt": "/opt/matos-tools/conda/envs/matos-scip-py313/bin/python",
    "mathematical-optimization": "/opt/matos-tools/bin/scip",
}
RECOMMENDED_IMPORTS = {
    "tabular-ml": "sklearn",
    "scikit-learn": "sklearn",
    "mace": "mace",
    "mace-finetune": "mace",
    "chgnet": "chgnet",
    "sevennet": "sevenn",
    "mattersim": "mattersim",
    "orb": "orb_models",
    "fairchem": "fairchem",
    "fairchem-finetune": "fairchem",
    "matgl": "matgl",
    "matgl-finetune": "matgl",
    "m3gnet": "m3gnet",
    "nequip": "nequip",
    "allegro": "allegro",
    "schnetpack": "schnetpack",
    "torchmd-net": "torchmdnet",
    "alignn": "alignn",
    "cantera": "cantera",
    "combustion": "cantera",
    "atomate2": "atomate2",
    "jobflow": "jobflow",
    "smol": "smol",
    "pycalphad": "pycalphad",
    "drugdisc": "rdkit",
    "scienceagentbench-l5": "deepchem",
    "hiscibench-l5": "deepchem",
    "mattools": "pydefect",
    "mattoolbench": "pydefect",
    "mattools-benchmark": "pydefect",
    "chemical-benchmark": "deepchem",
    "computational-chemistry-benchmark": "deepchem",
    "papyrus": "papyrus_scripts",
    "papyrus-scripts": "papyrus_scripts",
    "qsprpred": "qsprpred",
    "scaffviz": "scaffviz",
    "deepchem-benchmark": "deepchem",
    "modnet-benchmark": "modnet",
    "matminer-benchmark": "matminer",
    "mastml-benchmark": "mastml",
    "meeko": "meeko",
    "rdkit": "rdkit",
    "pubchem": "pubchempy",
    "chembl": "chembl_webresource_client",
    "xrd": "pymatgen",
    "calphad": "pycalphad",
    "nmr": "nmrglue",
    "orca-python": "scine_utilities",
    "phasefield": "numpy",
    "fenics": "dolfinx",
    "fenicsx": "dolfinx",
    "dolfinx": "dolfinx",
    "ufl": "ufl",
    "ffcx": "ffcx",
    "basix": "basix",
    "petsc4py": "petsc4py",
    "mpi4py": "mpi4py",
    "gmsh": "gmsh",
    "meshio": "meshio",
    "fem": "dolfinx",
    "finite-element": "dolfinx",
    "pde-solver": "dolfinx",
    "phonopy": "phonopy",
    "phono3py": "phono3py",
    "phonon-thermal-transport": "phono3py",
    "amset": "amset",
    "electronic-transport": "amset",
    "thermoelectric-transport": "amset",
    "wannierberri": "wannierberri",
    "z2pack": "z2pack",
    "gw-gpaw": "gpaw",
    "pyxtal": "pyxtal",
    "crystal-generation": "pyxtal",
    "random-structure-search": "pyxtal",
    "doped": "doped",
    "battery-electrochem": "pybamm",
    "pybamm": "pybamm",
    "pybop": "pybop",
    "bpx": "bpx",
    "liionpack": "liionpack",
    "openpnm": "openpnm",
    "pyscipopt": "pyscipopt",
    "pyvista": "pyvista",
    "vtk": "vtk",
    "mesh-visualization": "pyvista",
    "scientific-3d-visualization": "pyvista",
}
RUNTIME_HINTS = {
    "fenicsx": {
        "finiteElementRuntime": {
            "python": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/python",
            "gmsh": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/gmsh",
            "mpirun": "/opt/matos-tools/conda/envs/matos-fenicsx-py311/bin/mpirun",
            "packages": [
                "fenics-dolfinx",
                "fenics-ufl",
                "fenics-ffcx",
                "fenics-basix",
                "petsc4py",
                "mpi4py",
                "python-gmsh",
                "meshio",
                "pyvista",
            ],
            "versionFamily": "FEniCSx / dolfinx 0.11",
            "legacyFenicsDolfin": "not included; use dolfinx APIs and preflight old FEniCS repositories before promising execution",
            "smokeTest": "Import dolfinx, solve a tiny Poisson problem, and run mpirun -n 2 with the same script before reporting a workflow as executable.",
            "containerPathOnly": True,
        },
    },
    "pyvista": {
        "headlessRendering": {
            "python": "/opt/matos-tools/conda/envs/matos-pyvista-py311/bin/python",
            "envWhenLibOSMesaAvailable": {
                "PYVISTA_OFF_SCREEN": "true",
                "VTK_DEFAULT_OPENGL_WINDOW": "vtkOSOpenGLRenderWindow",
            },
            "envWhenEglAvailable": {
                "PYVISTA_OFF_SCREEN": "true",
                "VTK_DEFAULT_OPENGL_WINDOW": "vtkEGLRenderWindow",
            },
            "requiredLibraries": ["libOSMesa.so", "libEGL.so", "libGL.so", "libgbm.so"],
            "staleContainerSymptom": "Warnings such as 'libOSMesa not found' or 'Failed to initialize OpenGL functions' mean the workspace image lacks headless OpenGL runtime libraries. Use a refreshed MatOS workspace image before retrying.",
            "reason": "Refreshed MatOS workspace images include Mesa OSMesa/EGL runtime libraries. OSMesa is preferred for deterministic CPU headless rendering; EGL is an alternate backend when the runtime reports EGL availability.",
            "smokeTest": "Save a screenshot file and verify it is non-empty before reporting that PyVista rendering succeeded.",
        },
    },
    "mace-les": {
        "overlayRuntime": {
            "status": "available",
            "python": "/opt/matos-tools/conda/envs/matos-compute/bin/python",
            "binDir": "/opt/matos-tools/mace-les/bin",
            "envScript": "/opt/matos-tools/mace-les/env.sh",
            "pythonPath": [
                "/opt/matos-tools/src/chengucb-mace",
                "/opt/matos-tools/src/chengucb-les/src",
            ],
            "sourceRepos": {
                "mace": {
                    "url": "https://github.com/ChengUCB/mace",
                    "branch": "les_extension-merge-clean",
                    "commit": "a2792819f9172907d7fe509be6c8fd23b5017aad",
                    "path": "/opt/matos-tools/src/chengucb-mace",
                },
                "les": {
                    "url": "https://github.com/ChengUCB/les",
                    "branch": "main",
                    "commit": "fadfb0ca3b89ed371e5de6b383f4425defabd4a8",
                    "path": "/opt/matos-tools/src/chengucb-les",
                },
            },
            "commands": {
                "python": "/opt/matos-tools/mace-les/bin/mace-les-python",
                "train": "/opt/matos-tools/mace-les/bin/mace-les-run-train",
                "evalConfigs": "/opt/matos-tools/mace-les/bin/mace-les-eval-configs",
                "prepareData": "/opt/matos-tools/mace-les/bin/mace-les-prepare-data",
                "createLammpsModel": "/opt/matos-tools/mace-les/bin/mace-les-create-lammps-model",
                "plotTrain": "/opt/matos-tools/mace-les/bin/mace-les-plot-train",
                "selectHead": "/opt/matos-tools/mace-les/bin/mace-les-select-head",
                "activeLearningMd": "/opt/matos-tools/mace-les/bin/mace-les-active-learning-md",
                "finetuningSelect": "/opt/matos-tools/mace-les/bin/mace-les-finetuning-select",
                "convertDevice": "/opt/matos-tools/mace-les/bin/mace-les-convert-device",
            },
            "localSetup": "export PATH=/opt/matos-tools/mace-les/bin:$PATH",
            "remoteSetup": "export TOOLCHAIN=\"${MATOS_EXTERNAL_TOOLCHAIN_ROOT:?}\"; export MACE_LES_ROOT=\"$TOOLCHAIN\"; export MACE_LES_PYTHON=\"$TOOLCHAIN/conda/envs/matos-compute/bin/python\"; export PATH=\"$TOOLCHAIN/mace-les/bin:$TOOLCHAIN/conda/envs/matos-compute/bin:$TOOLCHAIN/bin:$PATH\"; export PYTHONPATH=\"$TOOLCHAIN/src/chengucb-mace:$TOOLCHAIN/src/chengucb-les/src:${PYTHONPATH:-}\"",
            "smokeTest": "mace-les-python -c 'import mace, e3nn, torch; from les import Les; print(mace.__file__, e3nn.__version__, torch.__version__, Les.__name__)'",
            "notes": [
                "This is an opt-in source overlay, not a cloned Conda environment.",
                "Do not override the default mace_run_train command for stable users; use the mace-les-* wrappers.",
                "The upstream les setup.py console entry points to les.main, which is not present; import Les from Python instead of calling a raw les executable.",
                "Use the discovered local interpreter and validate the model/runtime dependencies before running mace-les-run-train.",
            ],
        },
    },
}
for _alias in (
    "fenics",
    "dolfinx",
    "ufl",
    "ffcx",
    "basix",
    "petsc4py",
    "mpi4py",
    "gmsh",
    "meshio",
    "fem",
    "finite-element",
    "pde-solver",
):
    RUNTIME_HINTS[_alias] = RUNTIME_HINTS["fenicsx"]
for _alias in ("vtk", "mesh-visualization", "scientific-3d-visualization"):
    RUNTIME_HINTS[_alias] = RUNTIME_HINTS["pyvista"]
for _alias in ("mace-les-train", "chengucb-mace-les"):
    RUNTIME_HINTS[_alias] = RUNTIME_HINTS["mace-les"]
OPTIONAL_RECOMMENDED = {
    "mattergen": "/opt/matos-tools/conda/envs/matos-mattergen-py310/bin/python",
    "diffcsp": "/opt/matos-tools/conda/envs/matos-diffcsp-py311/bin/python",
    "adit": "/opt/matos-tools/conda/envs/matos-adit-py310/bin/python",
    "openmm": "/opt/matos-tools/conda/envs/matos-drugmd-openmm-py311/bin/python",
    "drugmd": "/opt/matos-tools/conda/envs/matos-drugmd-openmm-py311/bin/python",
    "mmpbsa": "/opt/matos-tools/conda/envs/matos-drugmd-openmm-py311/bin/MMPBSA.py",
    "react-ot": "/opt/matos-tools/conda/envs/matos-react-ot-py310/bin/python",
    "void": "/opt/matos-tools/conda/envs/matos-void-py310/bin/python",
    "scd": "/opt/matos-tools/conda/envs/matos-scd-py310/bin/python",
    "raspa3": "/opt/matos-tools/conda/envs/matos-raspa3-py312/bin/raspa3",
    "pw2wannier90": "/opt/matos-tools/bin/pw2wannier90.x",
    "wannierberri": "/opt/matos-tools/conda/envs/matos-wannier90-py311/bin/python",
    "z2pack": "/opt/matos-tools/conda/envs/matos-wannier90-py311/bin/python",
    "gw-yambo": "/opt/matos-tools/conda/envs/matos-gw-yambo-py311/bin/yambo",
    "gw-abinit": "/opt/matos-tools/bin/abinit",
    "gw-gpaw": "/opt/matos-tools/conda/envs/matos-gw-gpaw-py311/bin/python",
    "gw-berkeleygw": "/opt/matos-tools/conda/envs/matos-gw-berkeleygw/bin/epsilon.cplx.x",
    "gw-west": "/opt/matos-tools/conda/envs/matos-gw-west/bin/wstat.x",
}


def read_input() -> dict[str, Any]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return {}
    value = payload.get("input", payload)
    return value if isinstance(value, dict) else {}


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def toolchain_root_aliases() -> list[str]:
    aliases: set[str] = set()
    for key in (
        "MATOS_EXTERNAL_TOOLCHAIN_ROOT",
        "MATOS_CONTAINER_TOOLCHAIN_ROOT",
        "MATOS_COMPUTE_TOOLCHAIN_CONTAINER_ROOT",
    ):
        value = os.environ.get(key)
        if value:
            aliases.add(value)
    current = Path(__file__).resolve()
    for parent in current.parents:
        if parent.name == "CMatOS":
            aliases.add(str(parent.parent / "matos-tools"))
    normalized: set[str] = set()
    for alias in aliases:
        path = Path(alias)
        if path.name != "matos-tools":
            continue
        normalized.add(str(path))
        try:
            normalized.add(str(path.resolve()))
        except OSError:
            pass
    normalized.discard(CONTAINER_TOOLCHAIN_ROOT)
    return sorted(normalized, key=len, reverse=True)


def containerize_text_paths(text: str) -> str:
    output = text
    for alias in toolchain_root_aliases():
        output = output.replace(alias, CONTAINER_TOOLCHAIN_ROOT)
    return output


def containerize_paths(value: Any) -> Any:
    if isinstance(value, str):
        return containerize_text_paths(value)
    if isinstance(value, list):
        return [containerize_paths(item) for item in value]
    if isinstance(value, dict):
        return {key: containerize_paths(item) for key, item in value.items()}
    return value


def bool_value(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def int_value(value: Any, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, int) and minimum <= value <= maximum:
        return value
    return default


def float_value(value: Any, default: float, minimum: float, maximum: float) -> float:
    if isinstance(value, (int, float)) and minimum <= float(value) <= maximum:
        return float(value)
    return default


def string_list(value: Any, default: list[str]) -> list[str]:
    if not isinstance(value, list):
        return default.copy()
    cleaned = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return cleaned or default.copy()


def append_unique(items: list[str], additions: list[str]) -> list[str]:
    seen = set(items)
    result = items.copy()
    for item in additions:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def source_list(value: str | None) -> list[str]:
    if not value:
        return []
    text = value.strip()
    if text.startswith("["):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = []
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
    if "," in text:
        return [item.strip() for item in text.split(",") if item.strip()]
    if "\n" in text:
        return [item.strip() for item in text.splitlines() if item.strip()]
    if os.pathsep in text and "://" not in text:
        return [item.strip() for item in text.split(os.pathsep) if item.strip()]
    return [text]


def shell_join(items: list[str]) -> str:
    return " ".join(shlex.quote(item) for item in items)


def shell_env(name: str, value: str) -> str:
    return f"{name}={shlex.quote(value)}"


def split_paths(value: str | None) -> list[Path]:
    if not value:
        return []
    return [Path(item) for item in value.split(":") if item.strip()]


def unique_existing_dirs(paths: list[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        try:
            is_dir = path.is_dir()
        except OSError:
            is_dir = False
        if not is_dir:
            continue
        try:
            key = str(path.resolve())
        except OSError:
            key = str(path)
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result


def local_sibling_system_env_roots() -> list[Path]:
    roots: list[Path] = []
    current = Path(__file__).resolve()
    for parent in current.parents:
        if parent.name == "CMatOS":
            roots.append(parent.parent / "matos-tools" / "conda" / "envs")
    return roots


def system_roots() -> list[Path]:
    roots: list[Path] = []
    explicit_roots = split_paths(os.environ.get("MATOS_SYSTEM_CONDA_ENVS_PATH"))
    if explicit_roots:
        return unique_existing_dirs(explicit_roots)
    for key in (
        "MATOS_EXTERNAL_TOOLCHAIN_ROOT",
        "MATOS_CONTAINER_TOOLCHAIN_ROOT",
        "MATOS_COMPUTE_TOOLCHAIN_CONTAINER_ROOT",
    ):
        root = os.environ.get(key)
        if root:
            roots.append(Path(root) / "conda" / "envs")
    roots.extend(Path(item) for item in DEFAULT_SYSTEM_ENV_ROOTS)
    roots.extend(local_sibling_system_env_roots())
    return unique_existing_dirs(roots)


def user_roots() -> list[Path]:
    roots: list[Path] = []
    explicit_roots = split_paths(os.environ.get("MATOS_USER_CONDA_ENVS_PATH"))
    if explicit_roots:
        return unique_existing_dirs(explicit_roots)
    for path in split_paths(os.environ.get("CONDA_ENVS_PATH")):
        text = str(path)
        if text.startswith("/workspace/") or text.startswith(str(Path.home())):
            roots.append(path)
    roots.extend(Path(item) for item in DEFAULT_USER_ENV_ROOTS)
    return unique_existing_dirs(roots)


def source_routing() -> dict[str, Any]:
    pip_index_url = os.environ.get(
        "MATOS_PIP_INDEX_URL",
        os.environ.get("PIP_INDEX_URL", "https://pypi.org/simple/"),
    )
    uv_index_url = os.environ.get(
        "MATOS_UV_INDEX_URL",
        os.environ.get("UV_INDEX_URL", pip_index_url),
    )
    pip_extra_index_url = os.environ.get(
        "MATOS_PIP_EXTRA_INDEX_URL",
        os.environ.get("PIP_EXTRA_INDEX_URL", ""),
    )
    uv_extra_index_url = os.environ.get(
        "MATOS_UV_EXTRA_INDEX_URL",
        os.environ.get("UV_EXTRA_INDEX_URL", pip_extra_index_url),
    )
    conda_channels = source_list(
        os.environ.get("MATOS_CONDA_CHANNELS") or os.environ.get("CONDA_CHANNELS")
    )
    conda_channel_alias = os.environ.get(
        "MATOS_CONDA_CHANNEL_ALIAS",
        os.environ.get("CONDA_CHANNEL_ALIAS", ""),
    )
    conda_channel_args: list[str] = []
    if conda_channels:
        conda_channel_args.append("--override-channels")
        for channel in conda_channels:
            conda_channel_args.extend(["-c", channel])
    return {
        "profile": os.environ.get("MATOS_PACKAGE_SOURCE_PROFILE", "pypi"),
        "pip": {
            "indexUrl": pip_index_url,
            **({"extraIndexUrl": pip_extra_index_url} if pip_extra_index_url else {}),
            "env": {
                "PIP_INDEX_URL": pip_index_url,
                "PIP_DISABLE_PIP_VERSION_CHECK": os.environ.get(
                    "PIP_DISABLE_PIP_VERSION_CHECK", "1"
                ),
                **(
                    {"PIP_EXTRA_INDEX_URL": pip_extra_index_url}
                    if pip_extra_index_url
                    else {}
                ),
            },
        },
        "uv": {
            "indexUrl": uv_index_url,
            **({"extraIndexUrl": uv_extra_index_url} if uv_extra_index_url else {}),
            "env": {
                "UV_INDEX_URL": uv_index_url,
                **(
                    {"UV_EXTRA_INDEX_URL": uv_extra_index_url}
                    if uv_extra_index_url
                    else {}
                ),
            },
        },
        "conda": {
            "channels": conda_channels,
            **({"channelAlias": conda_channel_alias} if conda_channel_alias else {}),
            "channelArgs": conda_channel_args,
        },
    }


def runtime_library_status() -> dict[str, Any]:
    libraries = ["libOSMesa.so", "libEGL.so", "libGL.so", "libgbm.so"]
    try:
        result = subprocess.run(
            ["ldconfig", "-p"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "checkedWith": "ldconfig -p",
            "ok": False,
            "error": f"{type(error).__name__}: {error}",
            "headlessPyVistaReady": False,
        }
    output = f"{result.stdout}\n{result.stderr}"
    available = {name: name in output for name in libraries}
    osmesa_ready = bool(available.get("libOSMesa.so"))
    egl_ready = all(
        bool(available.get(name)) for name in ("libEGL.so", "libGL.so", "libgbm.so")
    )
    return {
        "checkedWith": "ldconfig -p",
        "ok": result.returncode == 0,
        "available": available,
        "headlessPyVistaReady": osmesa_ready or egl_ready,
        **(
            {
                "preferredPyVistaBackend": (
                    "vtkOSOpenGLRenderWindow" if osmesa_ready else "vtkEGLRenderWindow"
                ),
            }
            if osmesa_ready or egl_ready
            else {}
        ),
        **(
            {
                "warning": "This runtime is missing Mesa OSMesa/EGL libraries required for PyVista off-screen rendering.",
            }
            if not (osmesa_ready or egl_ready)
            else {}
        ),
    }


def _safe_is_file(path: Path, warnings: list[dict[str, Any]], context: str) -> bool:
    try:
        return path.is_file()
    except OSError as error:
        warnings.append(
            {
                "kind": "permission_or_filesystem_error",
                "context": context,
                "path": str(path),
                "error": f"{type(error).__name__}: {error}",
            }
        )
        return False


def _safe_access(path: Path, mode: int) -> bool:
    try:
        return os.access(path, mode)
    except OSError:
        return False


def _path_is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def candidate_envs(
    root: Path,
    scope: str,
    warnings: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    warnings = warnings if warnings is not None else []
    items: list[dict[str, Any]] = []
    try:
        children = sorted(root.iterdir(), key=lambda path: path.name)
    except OSError as error:
        warnings.append(
            {
                "kind": "environment_root_unreadable",
                "scope": scope,
                "path": str(root),
                "error": f"{type(error).__name__}: {error}",
            }
        )
        return items
    for child in children:
        python = child / "bin" / "python"
        python_available = _safe_is_file(
            python,
            warnings,
            "python_probe",
        ) and _safe_access(python, os.X_OK)
        executables = []
        for name in ENV_EXECUTABLE_PROBES:
            executable = child / "bin" / name
            if _safe_is_file(executable, warnings, "executable_probe") and _safe_access(
                executable,
                os.X_OK,
            ):
                executables.append(name)
        if python_available or executables:
            items.append(
                {
                    "name": child.name,
                    "scope": scope,
                    "path": str(child),
                    "python": str(python) if python_available else None,
                    "executables": executables,
                    "writable": scope == "user" and _safe_access(child, os.W_OK),
                    "filesystemWritable": _safe_access(child, os.W_OK),
                },
            )
    return items


def probe_env(
    python: str,
    imports: list[str],
    timeout: float,
    include_gpu: bool,
) -> dict[str, Any]:
    code = r"""
import importlib.metadata as md
import importlib.util
import json
import sys

imports = json.loads(sys.argv[1])
package_names = json.loads(sys.argv[2])
include_gpu = json.loads(sys.argv[3])
packages = {}
for name in imports:
    spec = importlib.util.find_spec(name)
    package_name = package_names.get(name, name.replace("_", "-"))
    version = None
    if spec is not None:
        for candidate in (package_name, name, name.replace("_", "-")):
            try:
                version = md.version(candidate)
                break
            except md.PackageNotFoundError:
                continue
    packages[name] = {
        "available": spec is not None,
        "origin": getattr(spec, "origin", None) if spec else None,
        "package": package_name,
        "version": version,
    }

torch_info = None
if packages.get("torch", {}).get("available"):
    try:
        import torch

        torch_info = {
            "version": getattr(torch, "__version__", None),
        }
        if include_gpu:
            torch_info.update({
                "cudaVersion": getattr(torch.version, "cuda", None),
                "cudaAvailable": bool(torch.cuda.is_available()),
                "deviceCount": int(torch.cuda.device_count()),
            })
    except Exception as error:
        torch_info = {"error": f"{type(error).__name__}: {error}"}

print(json.dumps({
    "pythonVersion": sys.version.split()[0],
    "executable": sys.executable,
    "packages": packages,
    "torch": torch_info,
}, ensure_ascii=False, sort_keys=True))
"""
    try:
        env = os.environ.copy()
        env["PIP_USER"] = "0"
        env["PYTHONNOUSERSITE"] = "1"
        env.pop("PYTHONUSERBASE", None)
        result = subprocess.run(
            [
                python,
                "-c",
                code,
                json.dumps(imports),
                json.dumps(PACKAGE_NAMES),
                json.dumps(include_gpu),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired as error:
        return {
            "ok": False,
            "status": "timeout",
            "stdout": error.stdout if isinstance(error.stdout, str) else "",
            "stderr": error.stderr if isinstance(error.stderr, str) else "",
        }
    except OSError as error:
        return {
            "ok": False,
            "status": "exec_error",
            "error": str(error),
        }
    if result.returncode != 0:
        return {
            "ok": False,
            "status": "failed",
            "exitCode": result.returncode,
            "stdout": result.stdout[-2000:],
            "stderr": result.stderr[-2000:],
        }
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {
            "ok": False,
            "status": "bad_json",
            "stdout": result.stdout[-2000:],
            "stderr": result.stderr[-2000:],
        }
    return {"ok": True, "status": "available", **data}


def recommended_by_model(
    recommended: dict[str, str],
    environments: list[dict[str, Any]],
    *,
    validate_imports: bool,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    env_by_name = {
        str(item.get("name")): item
        for item in environments
        if isinstance(item.get("name"), str)
    }
    for name, executable in recommended.items():
        path = Path(executable)
        env_root = path.parent.parent if path.parent.name == "bin" else None
        catalog_env = env_by_name.get(env_root.name if env_root else "")
        catalog_executable = None
        if catalog_env and isinstance(catalog_env.get("path"), str):
            candidate = Path(catalog_env["path"]) / "bin" / path.name
            try:
                candidate_exists = candidate.is_file()
            except OSError:
                candidate_exists = False
            if candidate_exists:
                catalog_executable = str(candidate)
        import_name = RECOMMENDED_IMPORTS.get(name)
        package_status = None
        package_available = None
        if (
            validate_imports
            and import_name
            and path.name == "python"
            and isinstance(catalog_env, dict)
        ):
            probe = catalog_env.get("probe")
            if isinstance(probe, dict) and probe.get("ok"):
                packages = probe.get("packages")
                if isinstance(packages, dict):
                    package = packages.get(import_name)
                    if isinstance(package, dict):
                        package_status = package
                        package_available = bool(package.get("available"))
        result[name] = {
            "executable": executable,
            "kind": "python" if path.name == "python" else "command",
            **({"environment": str(env_root), "envName": env_root.name} if env_root else {}),
            **({"catalogEnvironment": catalog_env.get("path")} if catalog_env else {}),
            **({"catalogExecutable": catalog_executable} if catalog_executable else {}),
            **({"requiredImport": import_name} if import_name else {}),
            **({"runtimeHints": RUNTIME_HINTS[name]} if name in RUNTIME_HINTS else {}),
            **({"packageStatus": package_status} if package_status is not None else {}),
            "exists": (_path_is_file(path) or bool(catalog_executable))
            and (package_available is not False),
            **(
                {
                    "pathExists": _path_is_file(path) or bool(catalog_executable),
                    "importAvailable": package_available,
                }
                if package_available is not None
                else {}
            ),
        }
    return result


def available_recommendations(
    recommended_status: dict[str, dict[str, Any]],
) -> dict[str, str]:
    result: dict[str, str] = {}
    for name, status in recommended_status.items():
        if not status.get("exists"):
            continue
        executable = status.get("executable") or status.get("catalogExecutable")
        if isinstance(executable, str) and executable:
            result[name] = executable
    return result


def unavailable_recommendations(
    recommended_status: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    return {
        name: {
            **status,
            "status": "unavailable",
            "reason": (
                "configured recommendation exists but its required import is unavailable"
                if status.get("pathExists") and status.get("importAvailable") is False
                else "configured recommendation is not executable in the current MatOS runtime"
            ),
        }
        for name, status in recommended_status.items()
        if not status.get("exists")
    }


def optional_by_model(
    optional_status: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name, status in optional_status.items():
        exists = bool(status.get("exists"))
        result[name] = {
            **status,
            "status": "available" if exists else "deferred",
            **(
                {}
                if exists
                else {
                    "reason": "optional model or tool stack is not executable in the current MatOS runtime",
                }
            ),
        }
    return result


def deferred_optional_stacks(
    optional_status: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    return {
        name: status
        for name, status in optional_by_model(optional_status).items()
        if status.get("status") == "deferred"
    }


def summary_stats(
    environments: list[dict[str, Any]],
    imports: list[str],
    *,
    include_gpu: bool,
) -> dict[str, Any]:
    by_scope: dict[str, int] = {}
    executable_counts: dict[str, int] = {}
    package_availability: dict[str, dict[str, Any]] = {
        name: {
            "availableEnvironments": 0,
            "environments": [],
            "package": PACKAGE_NAMES.get(name, name.replace("_", "-")),
        }
        for name in imports
    }
    torch_cuda = {
        "probed": 0,
        "cudaAvailableEnvironments": 0,
        "deviceCountMax": 0,
        "cudaVersions": [],
    }
    cuda_versions: set[str] = set()

    for item in environments:
        scope = str(item.get("scope") or "unknown")
        by_scope[scope] = by_scope.get(scope, 0) + 1
        for executable in item.get("executables") or []:
            name = str(executable)
            executable_counts[name] = executable_counts.get(name, 0) + 1
        probe = item.get("probe")
        if not isinstance(probe, dict) or not probe.get("ok"):
            continue
        packages = probe.get("packages")
        if isinstance(packages, dict):
            for name, package in packages.items():
                if not isinstance(package, dict) or not package.get("available"):
                    continue
                entry = package_availability.setdefault(
                    name,
                    {
                        "availableEnvironments": 0,
                        "environments": [],
                        "package": PACKAGE_NAMES.get(name, name.replace("_", "-")),
                    },
                )
                entry["availableEnvironments"] += 1
                entry["environments"].append(item.get("name"))
        torch = probe.get("torch")
        if include_gpu and isinstance(torch, dict):
            torch_cuda["probed"] += 1
            if torch.get("cudaAvailable"):
                torch_cuda["cudaAvailableEnvironments"] += 1
            device_count = torch.get("deviceCount")
            if isinstance(device_count, int):
                torch_cuda["deviceCountMax"] = max(torch_cuda["deviceCountMax"], device_count)
            cuda_version = torch.get("cudaVersion")
            if isinstance(cuda_version, str) and cuda_version:
                cuda_versions.add(cuda_version)

    return {
        "total": len(environments),
        "byScope": by_scope,
        "withPython": sum(1 for item in environments if item.get("python")),
        "writableUserEnvironments": sum(
            1 for item in environments if item.get("scope") == "user" and item.get("writable")
        ),
        "executableCounts": executable_counts,
        "packageAvailability": package_availability,
        **({"torchCuda": {**torch_cuda, "cudaVersions": sorted(cuda_versions)}} if include_gpu else {}),
    }


def compact_environment(
    item: dict[str, Any],
    imports: list[str],
    *,
    include_gpu: bool,
) -> dict[str, Any]:
    compact = {
        key: item[key]
        for key in (
            "name",
            "scope",
            "path",
            "python",
            "executables",
            "writable",
            "filesystemWritable",
        )
        if key in item
    }
    probe = item.get("probe")
    if not isinstance(probe, dict):
        return compact
    compact_probe = {
        key: probe[key]
        for key in ("ok", "status", "pythonVersion", "executable", "note", "error")
        if key in probe
    }
    packages = probe.get("packages")
    if isinstance(packages, dict):
        compact_probe["packages"] = {
            name: packages[name]
            for name in imports
            if name in packages
        }
    if include_gpu and "torch" in probe:
        compact_probe["torch"] = probe["torch"]
    for key in ("stdout", "stderr"):
        value = probe.get(key)
        if isinstance(value, str) and value:
            compact_probe[key] = value[-500:]
    compact["probe"] = compact_probe
    return compact


def main() -> int:
    payload = read_input()
    include_system = bool_value(payload.get("includeSystem"), True)
    include_user = bool_value(payload.get("includeUser"), True)
    probe_packages = bool_value(payload.get("probePackages"), False)
    include_gpu = bool_value(payload.get("includeGpu"), False)
    include_source_routing = bool_value(payload.get("includeSourceRouting"), True)
    explicit_imports = (
        string_list(payload.get("imports"), [])
        if isinstance(payload.get("imports"), list)
        else []
    )
    imports = explicit_imports or DEFAULT_IMPORTS.copy()
    response_format = (
        payload.get("format")
        if payload.get("format") in {"summary", "full"}
        else "summary"
    )
    if probe_packages and response_format == "full":
        imports = append_unique(imports, list(RECOMMENDED_IMPORTS.values()))
    timeout = float_value(payload.get("timeoutSeconds"), 12.0, 1.0, 30.0)
    limit = int_value(payload.get("limit"), 40, 1, 80)

    environments: list[dict[str, Any]] = []
    scan_warnings: list[dict[str, Any]] = []
    if include_system:
        for root in system_roots():
            environments.extend(candidate_envs(root, "system", scan_warnings))
    if include_user:
        for root in user_roots():
            environments.extend(candidate_envs(root, "user", scan_warnings))

    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in environments:
        key = str(item["path"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    deduped = sorted(deduped, key=lambda item: (item["scope"], item["name"]))[:limit]
    if probe_packages:
        for item in deduped:
            python = item.get("python")
            if isinstance(python, str) and python:
                item["probe"] = probe_env(python, imports, timeout, include_gpu)
            else:
                item["probe"] = {
                    "ok": False,
                    "status": "no_python",
                    "note": "This conda environment exposes command-line executables but no Python interpreter.",
                }

    user_root = (
        os.environ.get("MATOS_USER_CONDA_ENVS_PATH")
        or os.environ.get("CONDA_ENVS_PATH", "").split(":")[0]
        or "/workspace/caches/conda/envs"
    )
    pip_index_url = os.environ.get(
        "MATOS_PIP_INDEX_URL",
        os.environ.get("PIP_INDEX_URL", "https://pypi.org/simple/"),
    )
    route = source_routing()
    conda_args = route["conda"]["channelArgs"]
    conda_create_prefix = shell_join(
        [
            "conda",
            "create",
            *conda_args,
            "-p",
            f"{user_root}/<name>",
            "python=3.11",
        ],
    )
    conda_create_named = shell_join(
        ["conda", "create", *conda_args, "-n", "<name>", "python=3.11"],
    )
    pip_env = [shell_env("PIP_INDEX_URL", pip_index_url)]
    if route["pip"].get("extraIndexUrl"):
        pip_env.append(shell_env("PIP_EXTRA_INDEX_URL", route["pip"]["extraIndexUrl"]))
    pip_install = " ".join(
        [*pip_env, shell_join(["python", "-m", "pip", "install", "<package>"])]
    )
    recommended_status = recommended_by_model(
        RECOMMENDED,
        deduped,
        validate_imports=probe_packages,
    )
    optional_recommended_status = recommended_by_model(
        OPTIONAL_RECOMMENDED,
        deduped,
        validate_imports=probe_packages,
    )
    all_recommended_status = {**recommended_status, **optional_recommended_status}
    response = {
            "format": "full",
            "ok": True,
            "count": len(deduped),
            "environments": deduped,
            "summaryStats": summary_stats(
                deduped,
                imports,
                include_gpu=include_gpu,
            ),
            "systemRoots": [str(root) for root in system_roots()],
            "userRoots": [str(root) for root in user_roots()],
            "pipIndexUrl": pip_index_url,
            **({"sourceRouting": route} if include_source_routing else {}),
            "runtimeLibraryStatus": runtime_library_status(),
            "userEnvironmentPolicy": {
                "scopeRef": os.environ.get("MATOS_SCOPE_ID") or "current-user",
                "persistentEnvRoot": user_root,
                "visibility": "current-user-only",
                "isolation": "backed by the current MatOS runtime scope; not mounted for other users",
                "createNamedEnvCommand": conda_create_named,
                "createPrefixEnvCommand": conda_create_prefix,
                "pipInstallCommand": pip_install,
            },
            "recommended": available_recommendations(all_recommended_status),
            "recommendedByModel": recommended_status,
            "optionalByModel": optional_by_model(optional_recommended_status),
            "runtimeHints": {
                name: hint
                for name, hint in RUNTIME_HINTS.items()
                if name in all_recommended_status
            },
            "unavailableRecommended": unavailable_recommendations(recommended_status),
            "deferredOptionalStacks": deferred_optional_stacks(optional_recommended_status),
            **({"warnings": scan_warnings[:40]} if scan_warnings else {}),
            **({"warningCount": len(scan_warnings)} if scan_warnings else {}),
        }
    if response_format == "summary":
        explicit_import_set = set(explicit_imports)
        relevant_primary = {
            name: status
            for name, status in recommended_status.items()
            if RECOMMENDED_IMPORTS.get(name) in explicit_import_set
        }
        relevant_optional = {
            name: status
            for name, status in optional_recommended_status.items()
            if RECOMMENDED_IMPORTS.get(name) in explicit_import_set
        }
        relevant_status = {**relevant_primary, **relevant_optional}
        response = {
            "format": "summary",
            "ok": True,
            "count": len(deduped),
            "environments": [
                compact_environment(item, imports, include_gpu=include_gpu)
                for item in deduped
            ],
            "summaryStats": summary_stats(
                deduped,
                imports,
                include_gpu=include_gpu,
            ),
            "systemRoots": [str(root) for root in system_roots()],
            "userRoots": [str(root) for root in user_roots()],
            "pipIndexUrl": pip_index_url,
            **({"sourceRouting": route} if include_source_routing else {}),
            "runtimeLibraryStatus": runtime_library_status(),
            "userEnvironmentPolicy": response["userEnvironmentPolicy"],
            "recommended": available_recommendations(
                relevant_status if explicit_imports else all_recommended_status
            ),
            **(
                {"recommendedByModel": relevant_primary}
                if relevant_primary
                else {}
            ),
            **(
                {"optionalByModel": optional_by_model(relevant_optional)}
                if relevant_optional
                else {}
            ),
            **(
                {
                    "runtimeHints": {
                        name: RUNTIME_HINTS[name]
                        for name in relevant_status
                        if name in RUNTIME_HINTS
                    }
                }
                if any(name in RUNTIME_HINTS for name in relevant_status)
                else {}
            ),
            **(
                {"unavailableRecommended": unavailable_recommendations(relevant_primary)}
                if relevant_primary
                else {}
            ),
            **({"warnings": scan_warnings[:10]} if scan_warnings else {}),
            **({"warningCount": len(scan_warnings)} if scan_warnings else {}),
        }
    print_json(containerize_paths(response))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print_json({"ok": False, "error": "interrupted"})
        sys.exit(130)
