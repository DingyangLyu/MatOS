#!/usr/bin/env python3
"""Export only the reviewed benchmark reproduction asset file allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import os
import shutil
import tempfile

ROOT=Path(__file__).resolve().parents[1]
def export(destination, profile="workspace"):
    base=ROOT/"distribution/benchmark-minimal"
    if profile not in ("workspace","benchmark"):raise ValueError("Unknown profile")
    manifest=json.loads((base/("manifest.json" if profile=="workspace" else "manifest-benchmark.json")).read_text())
    source=base/("assets" if profile=="workspace" else "benchmark-assets")
    destination=destination.absolute()
    if destination.exists():raise ValueError("Choose a new output directory; existing output is preserved")
    destination.parent.mkdir(parents=True,exist_ok=True)
    records=[]
    seen=set()
    for record in manifest["files"]:
        rel=Path(record["path"])
        if rel.is_absolute() or ".." in rel.parts or str(rel) in seen:
            raise ValueError("Invalid or duplicate allowlisted path")
        seen.add(str(rel))
        file=source/rel
        if file.is_symlink() or not file.resolve().is_relative_to(source.resolve()) or not file.is_file():
            raise ValueError("Unsafe or missing allowlisted file: "+str(rel))
        raw=file.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=record["sha256"] or len(raw)!=record["bytes"]:
            raise ValueError("Review and refresh the manifest after editing: "+str(rel))
        records.append((rel,raw))
    stage=Path(tempfile.mkdtemp(prefix=".matos-minimal-",dir=destination.parent))
    try:
        for rel,raw in records:
            path=stage/"matos-assets"/rel
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(raw)
        (stage/"EXPORT.json").write_text(json.dumps(manifest,indent=2)+"\n")
        (stage/"README.md").write_text(
            "# MatOS asset package\n\n"
            f"This {manifest.get('profile','benchmark')} profile has {manifest['assetCount']} assets for the MatOS runtime.\n"
            "Point MATOS_BENCH_ASSET_ROOT at this matos-assets directory to use it with the benchmark wrapper.\n"
            "EXPORT.json lists every file with its hash.\n")
        os.rename(stage,destination)
    finally:
        if stage.exists():shutil.rmtree(stage)
    return {"ok":True,"output":str(destination),"assetCount":manifest["assetCount"],
            "assetFiles":len(records),"assetBytes":sum(len(raw) for _,raw in records)}
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--profile",choices=["benchmark","workspace"],default="benchmark")
    args=parser.parse_args()
    try:print(json.dumps(export(args.output,args.profile)))
    except (ValueError,OSError) as error:parser.exit(2,str(error)+"\n")
if __name__=="__main__":main()
