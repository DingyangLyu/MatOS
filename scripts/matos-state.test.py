"""Real filesystem/SQLite archive tests; no simulated model or runtime."""
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("state", Path(__file__).with_name("matos-state.py"))
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class Migration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / "old"
        self.assets = self.root / "assets"
        self.assets.mkdir()
        (self.assets / "note.txt").write_text("frozen asset")
        (self.source / "ui/projects/a/.matos").mkdir(parents=True)
        (self.source / "runtime/scopes/users/local/workflows/runs/r").mkdir(parents=True)
        state.json_write(self.source / "asset-profile.json", {"assetRoot": str(self.assets), "profile": "workspace"})
        state.json_write(self.source / "runtime-config.json", {"webPort": 0, "daemonPort": 0})
        state.json_write(self.source / "ui/projects/a/.matos/matos.json", {"assetRoots": ["assets"]})
        state.json_write(self.source / "runtime/scopes/users/local/workflows/runs/r/run.json",
                         {"status": "completed", "output": str(self.source / "runtime/result.txt")})
        (self.source / "runtime/result.txt").write_text("computed output")
        git = self.source / "empty.git"
        subprocess.run(["git", "init", "--bare", "--template=", str(git)], check=True, capture_output=True)
        subprocess.run(["git", "--git-dir", str(git), "config", "remote.origin.url", str(self.source / "upstream.git")], check=True)
        db = sqlite3.connect(self.source / "ui/app.sqlite")
        db.executescript("""
          CREATE TABLE projects(id TEXT, metadata TEXT);
          CREATE TABLE messages(content TEXT, produced_files_json TEXT, run_context_json TEXT);
          CREATE TABLE agent_sessions(cwd TEXT);
        """)
        old = str(self.source / "ui/projects/a")
        db.execute("INSERT INTO projects VALUES (?,?)", ("a", json.dumps({"baseDir": old})))
        db.execute("INSERT INTO messages VALUES (?,?,?)", ("Historical prose " + old, json.dumps([old + "/result.txt"]), "{}"))
        db.execute("INSERT INTO agent_sessions VALUES (?)", (old,))
        db.commit()
        db.close()
        self.archive = self.root / "backup.tgz"
        self.destination = self.root / "new"

    def test_roundtrip_preserves_results_and_history_and_rebinds_runtime(self):
        state.export_state(self.source, self.archive)
        result = state.restore_state(self.archive, self.destination)
        self.assertEqual(result["invalidatedUpstreamSessions"], 1)
        self.assertEqual((self.destination / "runtime/result.txt").read_text(), "computed output")
        self.assertEqual((self.destination / "bundled-assets/note.txt").read_text(), "frozen asset")
        origin = subprocess.check_output(["git", "--git-dir", str(self.destination / "empty.git"),
                                          "config", "remote.origin.url"], text=True).strip()
        self.assertEqual(origin, str(self.destination / "upstream.git"))
        self.assertTrue((self.destination / "empty.git/objects").is_dir())
        run = json.loads((self.destination / "runtime/scopes/users/local/workflows/runs/r/run.json").read_text())
        self.assertEqual(run["output"], str(self.destination / "runtime/result.txt"))
        with sqlite3.connect(self.destination / "ui/app.sqlite") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM agent_sessions").fetchone()[0], 0)
            self.assertIn(str(self.source), db.execute("SELECT content FROM messages").fetchone()[0])
            self.assertIn(str(self.destination), db.execute("SELECT produced_files_json FROM messages").fetchone()[0])
        # Restored state can itself be backed up without duplicating its bundle.
        state.json_write(self.destination / "runtime-config.json", {"webPort": 0, "daemonPort": 0})
        state.export_state(self.destination, self.root / "second.tgz")

    def test_alias_export_rebases_alias_and_canonical_state_paths(self):
        alias=self.root/"state-alias"
        alias.symlink_to(self.source,target_is_directory=True)
        subprocess.run(["git","--git-dir",str(self.source/"empty.git"),"config",
                        "remote.origin.url",str(alias/"upstream.git")],check=True)
        state.export_state(alias,self.archive)
        state.restore_state(self.archive,self.destination)
        origin=subprocess.check_output(["git","--git-dir",str(self.destination/"empty.git"),
                                        "config","remote.origin.url"],text=True).strip()
        self.assertEqual(origin,str(self.destination/"upstream.git"))
        run=json.loads((self.destination/"runtime/scopes/users/local/workflows/runs/r/run.json").read_text())
        self.assertEqual(run["output"],str(self.destination/"runtime/result.txt"))

    def test_existing_destination_is_never_overwritten(self):
        state.export_state(self.source, self.archive)
        self.destination.mkdir()
        (self.destination / "keep").write_text("existing")
        with self.assertRaisesRegex(ValueError, "new destination"):
            state.restore_state(self.archive, self.destination)
        self.assertEqual((self.destination / "keep").read_text(), "existing")

    def test_changed_archive_payload_is_rejected(self):
        state.export_state(self.source, self.archive)
        changed = self.root / "tampered.tgz"
        with tarfile.open(self.archive) as src, tarfile.open(changed, "w:gz") as out:
            for member in src.getmembers():
                data = src.extractfile(member).read() if member.isfile() else None
                if member.name == "base-assets/note.txt":
                    data = b"changed data"
                    member.size = len(data)
                out.addfile(member, io.BytesIO(data) if data is not None else None)
        with self.assertRaisesRegex(ValueError, "mismatch"):
            state.restore_state(changed, self.destination)
        self.assertFalse(self.destination.exists())

    def test_unlisted_traversal_is_rejected(self):
        state.export_state(self.source, self.archive)
        changed = self.root / "unsafe.tgz"
        with tarfile.open(self.archive) as src, tarfile.open(changed, "w:gz") as out:
            for member in src.getmembers():
                out.addfile(member, src.extractfile(member) if member.isfile() else None)
            member = tarfile.TarInfo("../outside")
            member.size = 4
            out.addfile(member, io.BytesIO(b"evil"))
        with self.assertRaisesRegex(ValueError, "allowlist"):
            state.restore_state(changed, self.destination)
        self.assertFalse((self.root / "outside").exists())

    def test_external_links_block_export(self):
        (self.source / "external").symlink_to(self.assets / "note.txt")
        with self.assertRaisesRegex(ValueError, "External"):
            state.export_state(self.source, self.archive)

    def test_active_workflow_blocks_export(self):
        state.json_write(self.source / "runtime/scopes/users/local/workflows/runs/r/run.json", {"status": "running"})
        with self.assertRaisesRegex(ValueError, "active workflows"):
            state.export_state(self.source, self.archive)


if __name__ == "__main__":
    unittest.main()
