#!/usr/bin/env python3
"""Supervise the existing MatOS web lifecycle; never replace its runtime."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def process_start(pid):
    try:
        return Path("/proc/" + str(pid) + "/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def write_json(path, data):
    tmp = path.with_suffix(".pending")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.chmod(0o600)
    os.replace(tmp, path)


def native(config, action):
    args = ["bash", str(ROOT / "scripts/matos-web.sh"), action,
            "--state-dir", config["state"], "--port", str(config["webPort"]),
            "--daemon-port", str(config["daemonPort"])]
    for field, flag in [("assetRoot", "--asset-root"), ("profile", "--asset-profile"), ("envFile", "--env-file")]:
        if config.get(field):
            args += [flag, config[field]]
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, timeout=240, env=os.environ.copy())


def healthy(port):
    try:
        with LOCAL_HTTP.open("http://127.0.0.1:" + str(port) + "/api/health", timeout=3) as response:
            return json.load(response).get("ok") is True
    except (OSError, ValueError):
        return False


def log(directory, message):
    path = directory / "supervisor.log"
    if path.exists() and path.stat().st_size > 8 * 1024**2:
        path.replace(directory / "supervisor.previous.log")
    with path.open("a") as out:
        out.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + message + "\n")


def status(state):
    directory = state / ".service"
    file = directory / "status.json"
    data = json.loads(file.read_text()) if file.exists() else {"state": "not-started"}
    try:
        os.kill(int(data["pid"]), 0)
        alive = time.time() - float(data["heartbeat"]) < 300
        if data.get("processStart") is not None:
            alive = alive and process_start(data["pid"]) == data["processStart"]
    except (OSError, KeyError, ValueError):
        alive = False
    return {**data, "supervisorAlive": alive}


def stop(state):
    directory = state / ".service"
    if not directory.exists():
        return {"ok": True, "state": "not-started"}
    (directory / "stop").touch()
    deadline = time.monotonic() + 90
    while status(state).get("supervisorAlive") and time.monotonic() < deadline:
        time.sleep(.5)
    if status(state).get("supervisorAlive"):
        raise ValueError("Supervisor is still stopping; inspect its log")
    return {"ok": True, "state": "stopped"}


def supervise(state):
    directory = state / ".service"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("This state already has a supervisor")
        config = json.loads((directory / "config.json").read_text())
        (directory / "stop").unlink(missing_ok=True)
        exiting = False

        def request_stop(*_):
            nonlocal exiting
            exiting = True

        signal.signal(signal.SIGTERM, request_stop)
        signal.signal(signal.SIGINT, request_stop)
        failures = 0
        restarts = 0
        owned_ready = False
        last_warnings = []
        # Native lifecycle validates namespace/process ownership and adopts
        # an already-running instance without cancelling its work.
        initial = True
        try:
            while not exiting and not (directory / "stop").exists():
                daemon_ok = healthy(config["daemonPort"])
                web_ok = healthy(config["webPort"])
                free = {"systemMiB": shutil.disk_usage("/").free // 1024**2,
                        "stateMiB": shutil.disk_usage(state).free // 1024**2}
                warnings = []
                if free["systemMiB"] < 2048:
                    warnings.append("System filesystem has less than 2 GiB free; MatOS caches remain in the state/install data directories.")
                if free["stateMiB"] < 1024:
                    warnings.append("State filesystem has less than 1 GiB free; increase storage before starting large jobs.")
                if warnings != last_warnings:
                    log(directory, "storage: " + ("; ".join(warnings) or "reserve restored"))
                    last_warnings = warnings
                record = {"pid": os.getpid(), "heartbeat": time.time(),
                          "processStart": process_start(os.getpid()),
                          "state": "healthy" if owned_ready and daemon_ok and web_ok else "recovering",
                          "daemonHealthy": daemon_ok, "webHealthy": web_ok,
                          "restartAttempts": restarts, "storageFree": free, "warnings": warnings}
                write_json(directory / "status.json", record)
                if initial or not (daemon_ok and web_ok):
                    initial = False
                    try:
                        result = native(config, "start")
                        if result.returncode != 0:
                            failures += 1
                            # Keep diagnostic output private and bounded.
                            log(directory, "native start failed: " + result.stdout[-2000:])
                        else:
                            failures = 0
                            restarts += 1
                            owned_ready = True
                            log(directory, "native lifecycle ready")
                    except subprocess.TimeoutExpired:
                        failures += 1
                        log(directory, "native lifecycle timed out; no process-name cleanup attempted")
                delay = min(60, max(3, 2 ** min(failures, 6)))
                for _ in range(delay * 2):
                    if exiting or (directory / "stop").exists():
                        break
                    time.sleep(.5)
        finally:
            try:
                result = native(config, "stop")
                log(directory, "native stop exit=" + str(result.returncode))
            finally:
                write_json(directory / "status.json", {"state": "stopped", "heartbeat": time.time()})


def configure(args):
    state = args.state_dir.resolve()
    directory = state / ".service"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    existing = directory / "config.json"
    prior = json.loads(existing.read_text()) if existing.exists() else {}
    binding = state / "asset-profile.json"
    old = json.loads(binding.read_text()) if binding.exists() else {}
    config = {"state": str(state), "webPort": args.port if args.port is not None else prior.get("webPort", 17464),
              "daemonPort": args.daemon_port if args.daemon_port is not None else prior.get("daemonPort", 17463),
              "profile": args.asset_profile or old.get("profile", "workspace"),
              "assetRoot": str(args.asset_root.resolve()) if args.asset_root else old.get("assetRoot"),
              "envFile": str(args.env_file.resolve()) if args.env_file else prior.get("envFile")}
    if status(state).get("supervisorAlive"):
        if config != prior:
            raise ValueError("Stop this supervisor before changing its configuration")
        return state
    write_json(directory / "config.json", config)
    return state


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["start", "run", "stop", "status", "systemd-unit", "supervisord-program"])
    p.add_argument("--state-dir", type=Path, required=True)
    p.add_argument("--port", type=int)
    p.add_argument("--daemon-port", type=int)
    p.add_argument("--asset-root", type=Path)
    p.add_argument("--asset-profile", choices=["workspace", "benchmark", "bundled"])
    p.add_argument("--env-file", type=Path)
    args = p.parse_args()
    state = args.state_dir.resolve()
    try:
        if args.action == "stop":
            print(json.dumps(stop(state)))
        elif args.action == "status":
            print(json.dumps(status(state)))
        elif args.action == "run":
            supervise(state)
        else:
            state = configure(args)
            if args.action == "start":
                if not status(state).get("supervisorAlive"):
                    directory = state / ".service"
                    with (directory / "launcher.log").open("a") as out:
                        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "run", "--state-dir", str(state)],
                                         stdout=out, stderr=out, stdin=subprocess.DEVNULL, start_new_session=True)
                deadline = time.monotonic() + 30
                while not status(state).get("supervisorAlive") and time.monotonic() < deadline:
                    time.sleep(.5)
                if not status(state).get("supervisorAlive"):
                    raise ValueError("Supervisor did not start; inspect .service/launcher.log")
                print(json.dumps(status(state)))
            else:
                identity = hashlib.sha256(str(state).encode()).hexdigest()[:12]
                # No credentials appear in generated service arguments.
                import shlex
                command = shlex.join([sys.executable, str(Path(__file__).resolve()), "run", "--state-dir", str(state)])
                if args.action == "systemd-unit":
                    print("[Unit]\nDescription=MatOS single-user workspace\nAfter=network-online.target\n"
                          "[Service]\nType=simple\nExecStart=" + command +
                          "\nRestart=on-failure\nRestartSec=5\nKillMode=process\nTimeoutStopSec=270\n"
                          "Environment=PATH=" + os.environ["PATH"] +
                          "\n[Install]\nWantedBy=multi-user.target")
                else:
                    print("[program:matos-" + identity + "]\ncommand=" + command +
                          "\nautostart=true\nautorestart=unexpected\nexitcodes=0\nstartsecs=3\nstopsignal=TERM\nstopwaitsecs=270\n"
                          "stdout_logfile=" + str(state / ".service/host-supervisor.log") +
                          "\nstdout_logfile_maxbytes=8MB\nstdout_logfile_backups=2\nredirect_stderr=true\n"
                          'environment=PATH="' + os.environ["PATH"].replace("%", "%%") + '"')
    except (OSError, ValueError, KeyError) as error:
        p.exit(2, "MatOS service: " + str(error) + "\n")


if __name__ == "__main__":
    main()
