#!/usr/bin/env python3
"""Checksum-protected, offline export/import of a single-user MatOS workspace."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import socket
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import uuid

SCHEMA = 1
TOP_CACHES = {"control", "tmp", "cache", "materialization", "bundled-assets", ".service"}
CONFIG_NAMES = {"matos.json", "project.json", "app-config.json"}


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def json_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def assert_stopped(state):
    service = state / ".service/status.json"
    if service.exists():
        data = json.loads(service.read_text())
        try:
            pid = int(data.get("pid", -1))
            if pid <= 0:
                raise ProcessLookupError()
            os.kill(pid, 0)
        except (OSError, ValueError):
            pass
        else:
            raise ValueError("Stop the MatOS supervisor before exporting state")
    config = state / "runtime-config.json"
    if config.exists():
        d = json.loads(config.read_text())
        for name in ["webPort", "daemonPort"]:
            port = int(d.get(name, 0))
            if port:
                with socket.socket() as s:
                    s.settimeout(.2)
                    if s.connect_ex(("127.0.0.1", port)) == 0:
                        raise ValueError("Stop this instance and its supervisor before exporting state")
    proc = Path("/proc")
    if proc.is_dir():
        expected = str(state / "ui").encode()
        for pid in proc.iterdir():
            if not pid.name.isdigit() or int(pid.name) == os.getpid():
                continue
            try:
                env = dict(x.split(b"=", 1) for x in (pid / "environ").read_bytes().split(b"\0") if b"=" in x)
            except (OSError, ValueError):
                continue
            if env.get(b"OD_DATA_DIR") == expected:
                raise ValueError("A process still owns this workspace; stop the instance before export")
    elif not config.exists():
        raise ValueError("Missing runtime-config.json; start/stop with the current launcher before exporting")


def skip(relative):
    parts = relative.parts
    if parts[0] in TOP_CACHES or parts[0] in {"supervisor.json", "supervisor.log", "supervisor.pid", "runtime-config.json"}:
        return True
    if "node_modules" in parts or "__pycache__" in parts:
        return True
    if parts[:2] in [("dsh", "profiles"), ("dsh", ".bin"), ("dsh", "cache")]:
        return True
    if ".matos" in parts:
        i = parts.index(".matos")
        if len(parts) > i + 1 and parts[i + 1] in {"tmp", "cache", "runtime", "runtime-data", "materialization"}:
            return True
    return relative.name.endswith((".sqlite-wal", ".sqlite-shm")) or relative.name == ".DS_Store"


def record_file(source, dest, relative, records):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.name.endswith(".sqlite"):
        read = sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True)
        write = sqlite3.connect(dest)
        try:
            read.backup(write)
            if write.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Database integrity check failed")
        finally:
            write.close()
            read.close()
    else:
        before = sha(source)
        shutil.copyfile(source, dest)
        if before != sha(source) or before != sha(dest):
            raise ValueError("Workspace changed while exporting: " + str(relative))
    mode = stat.S_IMODE(source.stat().st_mode) & 0o777
    dest.chmod(mode)
    records.append({"path": relative.as_posix(), "kind": "file", "bytes": dest.stat().st_size, "sha256": sha(dest), "mode": mode})


def export_state(state, output):
    state_alias = str(state.absolute())
    state = state.resolve(strict=True)
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Choose a new archive path")
    if output.is_relative_to(state):
        raise ValueError("The archive must be outside the exported state")
    assert_stopped(state)
    for run in (state / "runtime").rglob("run.json"):
        try:
            status = json.loads(run.read_text()).get("status")
        except (OSError, ValueError):
            continue
        if status in {"running", "created", "starting", "queued"}:
            raise ValueError("Finish or pause active workflows before migration: " + run.parent.name)
    binding = json.loads((state / "asset-profile.json").read_text())
    assets = Path(binding["assetRoot"]).resolve(strict=True)
    if binding["profile"] not in {"workspace", "benchmark", "bundled"}:
        raise ValueError("Unknown asset profile")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".matos-export-", dir=output.parent) as temp:
        stage = Path(temp)
        records = []
        for root, prefix in [(state, Path("state")), (assets, Path("base-assets"))]:
            for directory, dirs, files in os.walk(root, followlinks=False):
                rel_dir = Path(directory).relative_to(root)
                dirs[:] = sorted(d for d in dirs if not (root == state and skip(rel_dir / d)))
                dest_dir = stage / prefix / rel_dir
                dest_dir.mkdir(parents=True, exist_ok=True)
                mode = stat.S_IMODE(Path(directory).stat().st_mode) & 0o777
                dest_dir.chmod(mode)
                records.append({"path": (prefix / rel_dir).as_posix(), "kind": "directory", "mode": mode})
                for name in sorted(files + [d for d in dirs if (Path(directory) / d).is_symlink()]):
                    src = Path(directory) / name
                    rel = src.relative_to(root)
                    if root == state and skip(rel):
                        continue
                    target = stage / prefix / rel
                    if src.is_symlink():
                        resolved = src.resolve()
                        if not resolved.is_relative_to(root) or not resolved.exists():
                            raise ValueError("External/broken link needs a separate data migration: " + str(rel))
                        target.parent.mkdir(parents=True, exist_ok=True)
                        link = os.path.relpath(resolved, src.parent)
                        target.symlink_to(link)
                        records.append({"path": (prefix / rel).as_posix(), "kind": "symlink", "target": link})
                    elif src.is_file():
                        record_file(src, target, prefix / rel, records)
                    else:
                        raise ValueError("Unsupported workspace entry: " + str(rel))
        manifest = {"schemaVersion": SCHEMA, "kind": "matos-private-state", "oldState": str(state),
                    "oldAssetRoot": str(assets),
                    "oldStateAliases": sorted({state_alias, str(state)}),
                    "oldAssetRootAliases": sorted({str(Path(binding["assetRoot"]).absolute()), str(assets)}),
                    "profile": binding["profile"], "files": records}
        json_write(stage / "MANIFEST.json", manifest)
        archive = stage / "state.tar.gz"
        with tarfile.open(archive, "w:gz", dereference=False) as tar:
            tar.add(stage / "MANIFEST.json", arcname="MANIFEST.json")
            for row in records:
                tar.add(stage / row["path"], arcname=row["path"], recursive=False)
        archive.chmod(0o600)
        # Exclusive publication: never replace another backup.
        os.link(archive, output)
    return {"ok": True, "archive": str(output), "files": len(records), "sha256": sha(output)}


def checked_name(name):
    p = PurePosixPath(name)
    if p.is_absolute() or ".." in p.parts or not p.parts or any(ord(c) < 32 for c in name):
        raise ValueError("Unsafe archive path")
    if p.parts[0] not in {"state", "base-assets"}:
        raise ValueError("Unexpected archive root")
    return p


def remap(value, mappings):
    if isinstance(value, str):
        for old, new in mappings:
            if value == old or value.startswith(old + "/"):
                return new + value[len(old):]
        return value
    if isinstance(value, list):
        return [remap(v, mappings) for v in value]
    if isinstance(value, dict):
        return {k: remap(v, mappings) for k, v in value.items()}
    return value


def restore_state(archive, destination, max_bytes=100 * 1024**3):
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Restore requires a new destination; existing state is preserved")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".matos-import-", dir=destination.parent) as temp:
        stage = Path(temp)
        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getmembers()
            names = [m.name for m in members]
            if len(set(names)) != len(names) or names.count("MANIFEST.json") != 1:
                raise ValueError("Duplicate/missing archive manifest")
            meta_member = tar.getmember("MANIFEST.json")
            if not meta_member.isfile() or meta_member.size > 64 * 1024**2:
                raise ValueError("Invalid archive manifest")
            meta = json.load(tar.extractfile(meta_member))
            if meta.get("schemaVersion") != SCHEMA or meta.get("kind") != "matos-private-state":
                raise ValueError("Unsupported state format")
            rows = {r["path"]: r for r in meta["files"]}
            if len(rows) != len(meta["files"]) or set(names) != set(rows) | {"MANIFEST.json"}:
                raise ValueError("Archive file allowlist mismatch")
            if sum(m.size for m in members) > max_bytes:
                raise ValueError("Archive exceeds the import size limit")
            links = []
            for m in members:
                if m.name == "MANIFEST.json":
                    continue
                name = checked_name(m.name)
                row = rows[m.name]
                path = stage.joinpath(*name.parts)
                # Links are created last; no extraction can traverse them.
                path.parent.mkdir(parents=True, exist_ok=True)
                if m.isdir() and row["kind"] == "directory":
                    path.mkdir(exist_ok=True)
                    path.chmod(int(row["mode"]) & 0o777)
                elif m.isfile() and row["kind"] == "file":
                    if m.size != row["bytes"]:
                        raise ValueError("Archive file size mismatch")
                    with path.open("xb") as out:
                        shutil.copyfileobj(tar.extractfile(m), out)
                    if sha(path) != row["sha256"]:
                        raise ValueError("Archive checksum mismatch: " + m.name)
                    path.chmod(int(row["mode"]) & 0o777)
                elif m.issym() and row["kind"] == "symlink" and m.linkname == row["target"]:
                    target = (path.parent / m.linkname).resolve()
                    root = stage / name.parts[0]
                    if Path(m.linkname).is_absolute() or not target.is_relative_to(root):
                        raise ValueError("Unsafe archive symlink")
                    links.append((path, m.linkname))
                else:
                    raise ValueError("Unsupported archive entry")
            while links:
                remaining = []
                for path, target in links:
                    if path.exists():
                        raise ValueError("Conflicting archive symlink")
                    if (path.parent / target).exists():
                        path.symlink_to(target)
                    else:
                        remaining.append((path, target))
                if len(remaining) == len(links):
                    raise ValueError("Broken or cyclic archive symlink")
                links = remaining
        state = stage / "state"
        bundled = state / "bundled-assets"
        if bundled.exists():
            raise ValueError("Archive contains a reserved bundled-assets directory")
        (stage / "base-assets").rename(bundled)
        mappings = [
            *[(old, str(destination)) for old in meta.get("oldStateAliases", [meta["oldState"]])],
            *[(old, str(destination / "bundled-assets")) for old in meta.get("oldAssetRootAliases", [meta["oldAssetRoot"]])],
        ]
        mappings.sort(key=lambda item: len(item[0]), reverse=True)
        for config in state.rglob("config"):
            if config.is_symlink() or not (config.parent.name == ".git" or config.parent.name.endswith(".git")):
                continue
            result = subprocess.run(["git", "config", "--no-includes", "--file", str(config),
                                     "--get-regexp", r"^remote\..*\.url$"], capture_output=True, text=True)
            if result.returncode not in {0, 1}:
                raise ValueError("Cannot read a restored Git configuration")
            for line in result.stdout.splitlines():
                key, value = line.split(" ", 1)
                changed = remap(value, mappings)
                if changed != value:
                    subprocess.run(["git", "config", "--file", str(config), key, changed], check=True)
        # Only functional configuration is rebased. Frozen source assets,
        # transcript prose and Git objects retain their original evidence.
        for file in state.rglob("*.json"):
            rel = file.relative_to(state)
            workflow_record = rel.parts[0] == "runtime" and "workflows" in rel.parts
            if file.is_symlink() or rel.parts[0] == "bundled-assets":
                continue
            if not workflow_record and file.name not in CONFIG_NAMES:
                continue
            if not workflow_record and file.name in {"matos.json", "project.json"} and file.parent.name != ".matos":
                continue
            json_write(file, remap(json.loads(file.read_text()), mappings))
        dbfile = state / "ui/app.sqlite"
        invalidated = 0
        if dbfile.exists():
            db = sqlite3.connect(dbfile)
            try:
                if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise ValueError("Restored database integrity check failed")
                tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "agent_sessions" in tables:
                    invalidated = db.execute("SELECT COUNT(*) FROM agent_sessions").fetchone()[0]
                    db.execute("DELETE FROM agent_sessions")
                for table, columns in [("projects", ["metadata"]),
                                       ("messages", ["produced_files_json", "run_context_json"])]:
                    if table not in tables:
                        continue
                    available = {r[1] for r in db.execute("PRAGMA table_info(" + table + ")")}
                    for column in columns:
                        if column not in available:
                            continue
                        for rowid, value in db.execute("SELECT rowid," + column + " FROM " + table).fetchall():
                            if not value:
                                continue
                            try:
                                changed = json.dumps(remap(json.loads(value), mappings), ensure_ascii=False)
                            except (ValueError, TypeError):
                                continue
                            db.execute("UPDATE " + table + " SET " + column + "=? WHERE rowid=?", (changed, rowid))
                db.commit()
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                db.close()
        json_write(state / "asset-profile.json", {"assetRoot": str(destination / "bundled-assets"), "profile": meta["profile"]})
        receipt = {"schemaVersion": SCHEMA, "archiveSha256": sha(archive), "previousState": meta["oldState"],
                   "invalidatedUpstreamSessions": invalidated, "historyPreserved": True,
                   "note": "The next chat turn reseeds from preserved history in a new upstream session."}
        json_write(state / "migration-receipt.json", receipt)
        state.chmod(0o700)
        state.rename(destination)
    return {"ok": True, "state": str(destination), "profile": meta["profile"],
            "assetRoot": str(destination / "bundled-assets"), **receipt}


def rebind_assets(state, assets, profile):
    state = state.resolve(strict=True)
    assets = assets.resolve(strict=True)
    assert_stopped(state)
    root = Path(__file__).resolve().parents[1]
    subprocess.run(["bun", str(root / "scripts/matos-minimal-assets-check.ts"), str(assets), profile], check=True)
    env = os.environ.copy()
    for key in ["MATOS_ASSET_ROOTS", "MATOS_DEFAULT_ASSET_ROOTS", "MATOS_SCOPE_REF", "MATOS_PROJECT_CWD", "MATOS_ORIGINAL_CWD"]:
        env.pop(key, None)
    env["MATOS_BUNDLED_ASSET_ROOT"] = str(assets)
    # Validate scoped accepted assets against the new base before publishing.
    for cwd in [state / "workspace", *sorted((state / "ui/projects").glob("*"))]:
        if not (cwd / ".matos/matos.json").is_file():
            continue
        env["MATOS_ASSETS_CWD"] = str(cwd)
        result = subprocess.run([str(root / "bin/matos"), "assets", "validate", "--json"], cwd=cwd, env=env,
                                capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise ValueError("New base is incompatible with scoped assets: " + result.stdout[-1500:] + result.stderr[-500:])
    old = state / "asset-profile.json"
    if old.exists():
        history = state / "asset-profile-history" / (uuid.uuid4().hex + ".json")
        history.parent.mkdir(exist_ok=True)
        shutil.copy2(old, history)
    pending = state / "asset-profile.pending"
    json_write(pending, {"assetRoot": str(assets), "profile": profile})
    os.replace(pending, old)
    return {"ok": True, "state": str(state), "assetRoot": str(assets), "profile": profile}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("export")
    p.add_argument("--state-dir", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p = sub.add_parser("import")
    p.add_argument("--archive", required=True, type=Path)
    p.add_argument("--state-dir", required=True, type=Path)
    p.add_argument("--max-bytes", type=int, default=100 * 1024**3)
    p = sub.add_parser("rebind-assets")
    p.add_argument("--state-dir", required=True, type=Path)
    p.add_argument("--asset-root", required=True, type=Path)
    p.add_argument("--asset-profile", choices=["workspace", "benchmark"], default="workspace")
    args = parser.parse_args()
    try:
        if args.action == "export":
            result = export_state(args.state_dir, args.output)
        elif args.action == "import":
            result = restore_state(args.archive, args.state_dir, args.max_bytes)
        else:
            result = rebind_assets(args.state_dir, args.asset_root, args.asset_profile)
        print(json.dumps(result))
    except (OSError, ValueError, KeyError, sqlite3.Error, tarfile.TarError, subprocess.SubprocessError) as error:
        parser.exit(2, "State migration: " + str(error) + "\n")


if __name__ == "__main__":
    main()
