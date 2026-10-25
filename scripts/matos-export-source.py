#!/usr/bin/env python3
"""Export a clean committed source snapshot, without development state or Git history."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

ROOT=Path(__file__).resolve().parents[1]
PREFIX="MatOS-DSH-PUB"
# Development-only files (agent instructions, branch CI) stay out of the public snapshot.
DEV_ONLY_NAMES={"AGENTS.md"}
DEV_ONLY_PATHS={".github/workflows/dsh-pub.yml"}

def git(*args):
    return subprocess.check_output(["git","-C",str(ROOT),*args])

def allowed(path):
    parts=PurePosixPath(path).parts
    if not parts or ".." in parts or path.startswith("/"):
        return False
    if parts[0] in {".git",".matos",".tmp-test","node_modules","matos-assets","artifacts","papers"}:
        return False
    if any(p in {"node_modules",".git",".next","__pycache__",".matos",".tmp",".tmp-test",".claude"} for p in parts):
        return False
    name=parts[-1]
    if name in {".env",".env.deploy","provider.env",".credentials.json","id_ed25519","id_rsa"}:
        return False
    if name.startswith(".env.") and not name.endswith(".example"):
        return False
    if name.endswith((".safetensors",".ckpt",".pth",".pt",".pem")):
        return False
    return True

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output",type=Path,required=True)
    args=p.parse_args()
    out=args.output.resolve()
    if out.exists():p.error("Choose a new archive path; existing output is preserved.")
    if git("status","--porcelain").strip():p.error("Commit the final reviewed changes before exporting.")
    commit=git("rev-parse","HEAD").decode().strip()
    epoch=int(git("show","-s","--format=%ct","HEAD").decode())
    stamp=git("show","-s","--format=%cI","HEAD").decode().strip()
    raw=git("archive","--format=tar","HEAD")
    records=[]
    archive=io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw),mode="r:") as source, tarfile.open(fileobj=archive,mode="w") as target:
        for member in source.getmembers():
            if member.name in {"build-info.json","SOURCE-MANIFEST.json"} or member.name in DEV_ONLY_PATHS or PurePosixPath(member.name).name in DEV_ONLY_NAMES:continue
            if not allowed(member.name):raise ValueError("Forbidden source-snapshot path: "+member.name)
            if member.issym() or member.islnk():
                link=PurePosixPath(member.linkname)
                if link.is_absolute() or ".." in link.parts:
                    raise ValueError("Review source symlink before export: "+member.name)
            payload=source.extractfile(member).read() if member.isfile() else None
            if payload is not None:
                records.append({"path":member.name,"bytes":len(payload),"sha256":hashlib.sha256(payload).hexdigest()})
            member.name=PREFIX+"/"+member.name
            member.uid=member.gid=0
            member.uname=member.gname=""
            member.mtime=epoch
            member.pax_headers={}
            target.addfile(member,io.BytesIO(payload) if payload is not None else None)
        build={"version":json.loads(git("show","HEAD:package.json"))["version"],"commit":commit,"commitShort":commit[:12],"builtAt":stamp,"channel":"DSH-PUB","dirty":False}
        extra={"build-info.json":json.dumps(build,indent=2)+"\n"}
        for name,text in extra.items():
            data=text.encode()
            records.append({"path":name,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
            info=tarfile.TarInfo(PREFIX+"/"+name);info.size=len(data);info.mode=0o644;info.mtime=epoch
            target.addfile(info,io.BytesIO(data))
        manifest={"schemaVersion":1,"sourceCommit":commit,"sourceTree":git("rev-parse","HEAD^{tree}").decode().strip(),
                  "files":sorted(records,key=lambda r:r["path"]),
                  "scope":"Committed source only; no Git history, runtime state, model weights or installed dependencies."}
        data=(json.dumps(manifest,indent=2)+"\n").encode()
        info=tarfile.TarInfo(PREFIX+"/SOURCE-MANIFEST.json");info.size=len(data);info.mode=0o644;info.mtime=epoch
        target.addfile(info,io.BytesIO(data))
    out.parent.mkdir(parents=True,exist_ok=True)
    with out.open("xb") as destination:
        with gzip.GzipFile(filename="",mode="wb",fileobj=destination,mtime=0) as compressed:
            compressed.write(archive.getvalue())
    print(json.dumps({"ok":True,"commit":commit,"files":len(records)+1,"bytes":out.stat().st_size,
                      "sha256":hashlib.sha256(out.read_bytes()).hexdigest(),"archive":str(out)}))

if __name__=="__main__":main()
