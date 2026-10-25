#!/usr/bin/env bash
#
# Copyright 2025 coze-dev Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

set -euo pipefail

cd "$(dirname "$0")/.."

python3 - "./scripts/sciagentgym-official-eval.py" <<'PY'
import importlib.util
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("official_eval", sys.argv[1])
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["official_eval"] = module
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as tmp:
    case_dir = Path(tmp)
    (case_dir / "submission").mkdir()
    (case_dir / "logs").mkdir()

    # This simulates the historical MatOS bug: final_answer.txt was over-normalized
    # and lost the chemical prefix after a colon inside the molecule name.
    (case_dir / "submission" / "final_answer.txt").write_text(
        "5,6-c':9,10-c'']trifuran-1,3,6,8,11,13-hexaone\n",
        encoding="utf-8",
    )
    (case_dir / "submission" / "final_answer.raw.txt").write_text(
        r"""**Answer:** \boxed{\text{triphenyleno}[1,2\text{-c:}5,6\text{-c':}9,10\text{-c''}]\text{trifuran-}1,3,6,8,11,13\text{-hexaone}}""",
        encoding="utf-8",
    )
    (case_dir / "logs" / "matos.protocol_adapt.stdout.log").write_text(
        r"""\boxed{\text{triphenyleno}[1,2\text{-c:}5,6\text{-c':}9,10\text{-c''}]\text{trifuran-}1,3,6,8,11,13\text{-hexaone}}""",
        encoding="utf-8",
    )

    candidate = module.select_public_answer_candidate(case_dir, "public-richest")
    assert candidate.path.name == "final_answer.raw.txt", candidate
    assert candidate.extracted == (
        "triphenyleno[1,2-c:5,6-c':9,10-c'']trifuran-1,3,6,8,11,13-hexaone"
    ), candidate

    default_candidate = module.select_public_answer_candidate(case_dir, "submission")
    assert default_candidate.path.name == "final_answer.txt", default_candidate
    assert default_candidate.extracted.startswith("5,6-c'"), default_candidate

with tempfile.TemporaryDirectory() as tmp:
    case_dir = Path(tmp)
    (case_dir / "submission").mkdir()
    (case_dir / "logs").mkdir()

    # Historical MatOS normalization dropped the first assignment label because
    # it treated the colon in "Ir 4f7/2:" as a generic answer-label separator.
    (case_dir / "submission" / "final_answer.txt").write_text(
        "61.89 eV, Ir 4f5/2: 63.86 eV\n",
        encoding="utf-8",
    )
    (case_dir / "logs" / "matos.protocol_adapt.stdout.log").write_text(
        r"\boxed{Ir\ 4f_{7/2}: 61.89\ \text{eV},\ Ir\ 4f_{5/2}: 63.86\ \text{eV}}",
        encoding="utf-8",
    )

    candidate = module.select_public_answer_candidate(case_dir, "public-richest")
    assert candidate.path.name == "matos.protocol_adapt.stdout.log", candidate
    assert candidate.extracted.startswith("Ir 4f7/2: 61.89 eV"), candidate

with tempfile.TemporaryDirectory() as tmp:
    case_dir = Path(tmp)
    (case_dir / "submission").mkdir()
    (case_dir / "logs").mkdir()

    # Historical MatOS normalization collapsed XRD reflection labels and angles
    # into unreadable number runs. The protocol stdout still has the public
    # complete answer.
    (case_dir / "submission" / "final_answer.txt").write_text(
        "110.26.45^ 101.33.68^ 200.37.76^ 211.51.49^ 220.54.47^ . Lattice parameters: a = b = 4.76 , c = 3.20\n",
        encoding="utf-8",
    )
    (case_dir / "logs" / "matos.protocol_adapt.stdout.log").write_text(
        r"\boxed{\text{Single-phase SnO}_2\text{ (cassiterite, tetragonal rutile, }P4_2/mnm\text{). Primary peaks: (110) }26.45^\circ\text{, (101) }33.68^\circ\text{. Lattice parameters: }a = b = 4.76\,\text{\AA},\;c = 3.20\,\text{\AA}.}}",
        encoding="utf-8",
    )

    candidate = module.select_public_answer_candidate(case_dir, "public-richest")
    assert candidate.path.name == "matos.protocol_adapt.stdout.log", candidate
    assert "Single-phase SnO2" in candidate.extracted, candidate
    assert "(110) 26.45" in candidate.extracted, candidate

print("sciagentgym-official-eval-test-ok")
PY
