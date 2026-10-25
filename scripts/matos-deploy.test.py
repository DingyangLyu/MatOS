"""Deployment helper tests: real files, sockets and a local HTTP download server; no network."""
import functools
import hashlib
import http.server
import importlib.util
import io
import os
from pathlib import Path
import socket
import stat
import tarfile
import tempfile
import threading
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).with_name("matos-deploy.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def config(tmp, **overrides):
    cfg = dict(deploy.DEFAULTS)
    cfg.update({"state_dir": str(tmp / "state"), "env_file": str(tmp / "matos.env"),
                "toolchain_dir": str(tmp / "toolchain")})
    cfg.update(overrides)
    return cfg


class Base(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.tmp = Path(self.tmpdir.name).resolve()


class Config(Base):
    def setUp(self):
        super().setUp()
        # The regression runner keeps temp files inside the checkout; give the
        # program its own root so temp data dirs count as outside it.
        original = deploy.ROOT
        deploy.ROOT = self.tmp / "program"
        self.addCleanup(setattr, deploy, "ROOT", original)

    def test_template_round_trip_is_private(self):
        path = self.tmp / "matos-deploy.conf"
        deploy.write_config(path, {"web_port": "18000", "deepseek_api_key": "sk-test-0123456789"})
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        loaded = deploy.load_config(path)
        self.assertEqual(loaded["web_port"], "18000")
        self.assertEqual(loaded["deepseek_api_key"], "sk-test-0123456789")
        self.assertEqual(loaded["daemon_port"], deploy.DEFAULTS["daemon_port"])

    def test_validation_names_each_problem(self):
        errors = deploy.validate_config(config(self.tmp, web_port="17474", daemon_port="17474", autostart="always"))
        self.assertEqual(len(errors), 2)
        inside = deploy.validate_config(config(self.tmp, state_dir=str(deploy.ROOT / "data")))
        self.assertEqual(len(inside), 1)
        self.assertEqual(deploy.validate_config(config(self.tmp)), [])


class EnvFile(Base):
    def test_updates_owned_keys_and_keeps_the_rest(self):
        env = self.tmp / "matos.env"
        env.write_text("# mine\nDEEPSEEK_API_KEY=sk-old-0123456789\nCUSTOM=1\n")
        path, has_key = deploy.write_env_file(config(self.tmp, deepseek_api_key="", model="deepseek-pro"))
        text = path.read_text()
        self.assertTrue(has_key)
        self.assertIn("DEEPSEEK_API_KEY=sk-old-0123456789", text)
        self.assertIn("CUSTOM=1", text)
        self.assertIn("MATOS_DSH_MODEL=deepseek-pro", text)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        deploy.write_env_file(config(self.tmp, deepseek_api_key="sk-new-0123456789"))
        self.assertEqual(path.read_text().count("DEEPSEEK_API_KEY="), 1)
        self.assertIn("DEEPSEEK_API_KEY=sk-new-0123456789", path.read_text())

    def test_reports_a_missing_key(self):
        _, has_key = deploy.write_env_file(config(self.tmp))
        self.assertFalse(has_key)


class Diagnosis(unittest.TestCase):
    def test_setup_logs_map_to_guide_codes(self):
        cases = {
            "npm ERR! code ETIMEDOUT": "I03",
            "error: GET https://registry.npmjs.org/x - 503": "I03",
            "gyp ERR! stack Error: not found: make": "I04",
            "ENOSPC: no space left on device, write": "I05",
            "/lib64/libc.so.6: version `GLIBC_2.28' not found": "C03",
            "FATAL ERROR: JavaScript heap out of memory": "C11",
            "something unexpected": "I06",
        }
        for text, code in cases.items():
            self.assertEqual(deploy.diagnose_setup_log(text), code, text)

    def test_redaction(self):
        text = deploy.redact("key sk-abcdefghijkl and API_KEY=secret-value plus raw-key",
                             {"deepseek_api_key": "raw-key"})
        self.assertNotIn("sk-abcdefghijkl", text)
        self.assertNotIn("secret-value", text)
        self.assertNotIn("raw-key", text)

    def test_bun_build_matches_the_cpu(self):
        self.assertEqual(deploy.bun_asset_name("x64", True), "bun-linux-x64")
        self.assertEqual(deploy.bun_asset_name("x64", False), "bun-linux-x64-baseline")
        self.assertEqual(deploy.bun_asset_name("arm64", True), "bun-linux-aarch64")


class Autostart(Base):
    def test_cron_entry_is_replaced_and_removed_by_marker(self):
        cfg = config(self.tmp)
        line = deploy.cron_line(cfg, "/opt/node/bin:/usr/bin")
        self.assertTrue(line.startswith("@reboot PATH="))
        self.assertIn("matos-service.py start --state-dir", line)
        existing = "MAILTO=me\n0 1 * * * backup\n" + line.replace("start", "old") + "\n"
        updated = deploy.replace_cron(existing, cfg, line)
        self.assertEqual(updated.count("# matos-deploy:"), 1)
        self.assertIn("0 1 * * * backup", updated)
        self.assertNotIn("# matos-deploy:", deploy.replace_cron(updated, cfg, ""))

    def test_systemd_user_unit_runs_the_supervisor_in_the_foreground(self):
        unit = deploy.systemd_unit(config(self.tmp), "/opt/node/bin:/usr/bin")
        self.assertIn("matos-service.py run --state-dir", unit)
        self.assertIn("WantedBy=default.target", unit)
        self.assertIn("Environment=PATH=/opt/node/bin:/usr/bin", unit)


class Service(Base):
    def test_model_verification_reports_the_reason_in_words(self):
        original = deploy.local_json
        self.addCleanup(setattr, deploy, "local_json", original)
        cfg = config(self.tmp)
        deploy.local_json = lambda *args, **kwargs: {"ok": False, "message": 'HTTP 402: {"error":{"message":"Insufficient Balance"}}'}
        ok, detail = deploy.verify_model(cfg)
        self.assertFalse(ok)
        self.assertIn("402", detail)
        self.assertNotIn("{", detail)
        deploy.local_json = lambda *args, **kwargs: {"ok": True, "status": {"model": "deepseek-flash"}}
        self.assertEqual(deploy.verify_model(cfg), (True, "deepseek-flash"))

    def test_assets_stay_bound_when_the_program_did_not_move(self):
        cfg = config(self.tmp)
        state = deploy.expand(cfg["state_dir"])
        state.mkdir(parents=True)
        (state / "asset-profile.json").write_text(
            '{"assetRoot": "%s", "profile": "workspace"}' % deploy.current_asset_root("workspace"))
        original = deploy.subprocess.run
        self.addCleanup(setattr, deploy.subprocess, "run", original)
        deploy.subprocess.run = lambda *args, **kwargs: self.fail("rebind must not run")
        deploy.rebind_assets_if_moved(cfg)


class Checks(Base):
    def test_an_occupied_port_fails_with_a_fix(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            port = sock.getsockname()[1]
            checks = deploy.run_checks(config(self.tmp, web_port=str(port), daemon_port=str(port + 1)), network=False)
        port_checks = [item for item in checks if item["code"] == "C12"]
        self.assertEqual(port_checks[0]["status"], deploy.FAIL)
        self.assertIn(str(port), port_checks[0]["fix"])
        self.assertTrue({"C01", "C04", "C07", "C08", "C09"} <= {item["code"] for item in checks})


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Toolchain(Base):
    def setUp(self):
        super().setUp()
        self.www = self.tmp / "www"
        self.www.mkdir()
        handler = functools.partial(QuietHandler, directory=str(self.www))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        # Pretend no matching Node/Bun is installed so the private copies are used.
        original = deploy.command_version
        deploy.command_version = lambda *args, **kwargs: (None, None)
        self.addCleanup(setattr, deploy, "command_version", original)
        os.environ["no_proxy"] = "127.0.0.1"

    def publish(self, folder, name, data):
        directory = self.www / folder
        directory.mkdir(parents=True, exist_ok=True)
        (directory / name).write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        with (directory / "SHASUMS256.txt").open("a") as sums:
            sums.write(f"{digest}  {name}\n")

    def test_private_bun_is_downloaded_verified_and_executable(self):
        asset = deploy.bun_asset_name(deploy.machine_arch() or "x64", deploy.cpu_has_avx2())
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            zf.writestr(f"{asset}/bun", "#!/bin/sh\necho 1.3.14\n")
        self.publish(f"bun-v{deploy.BUN_VERSION}", f"{asset}.zip", buffer.getvalue())
        cfg = config(self.tmp, bun_mirror=self.base)
        deploy.ensure_bun(cfg)
        binary = deploy.toolchain_paths(cfg)["bun"] / "bun"
        self.assertTrue(os.access(binary, os.X_OK))
        self.assertEqual(deploy.bun_status(cfg)[0], "private")

    def test_private_node_is_downloaded_and_a_bad_checksum_is_rejected(self):
        arch = deploy.machine_arch() or "x64"
        name = f"node-v{deploy.NODE_VERSION}-linux-{arch}"
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:xz") as tar:
            data = b"#!/bin/sh\necho v24\n"
            info = tarfile.TarInfo(f"{name}/bin/node")
            info.size, info.mode = len(data), 0o755
            tar.addfile(info, io.BytesIO(data))
        folder = f"v{deploy.NODE_VERSION}"
        self.publish(folder, f"{name}.tar.xz", buffer.getvalue())
        cfg = config(self.tmp, node_mirror=self.base)
        deploy.ensure_node(cfg)
        self.assertTrue((deploy.toolchain_paths(cfg)["node"] / "node").exists())

        corrupted = config(self.tmp / "other", node_mirror=self.base)
        (self.www / folder / f"{name}.tar.xz").write_bytes(b"tampered")
        with self.assertRaises(deploy.DeployError) as raised:
            deploy.ensure_node(corrupted)
        self.assertEqual(raised.exception.code, "I02")


if __name__ == "__main__":
    unittest.main()
