#!/usr/bin/env python3
"""One-command MatOS deployment for a single Linux user account, without root.

Reads matos-deploy.conf, checks the machine, downloads a private Node and Bun
when the system ones do not match, installs, writes the model environment
file, starts the service, verifies it and optionally sets up autostart.
Every failure carries a code that docs/deploy.md explains.

  ./deploy.sh              deploy (or redeploy) with matos-deploy.conf
  ./deploy.sh check        system check only
  ./deploy.sh init         write or interactively fill matos-deploy.conf
  ./deploy.sh start|stop|restart|status|logs
  ./deploy.sh report       bundle redacted diagnostics for whoever helps you
  ./deploy.sh uninstall    stop the service and remove autostart (files kept)
"""
import argparse
import configparser
import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NODE_VERSION = "24.18.0"
BUN_VERSION = "1.3.14"
DEFAULT_CONFIG = ROOT / "matos-deploy.conf"
DEPLOY_DIR = ROOT / ".matos" / "deploy"
GUIDE = "docs/deploy.md"
DEFAULT_REGISTRY = "https://registry.npmjs.org"
DEFAULT_NODE_MIRROR = "https://nodejs.org/dist"
DEFAULT_BUN_MIRROR = "https://github.com/oven-sh/bun/releases/download"
DEFAULT_MODEL_URL = "https://api.deepseek.com"
CHINA_MIRRORS = {
    "npm_registry": "https://registry.npmmirror.com",
    "node_mirror": "https://npmmirror.com/mirrors/node",
    "bun_mirror": "https://registry.npmmirror.com/-/binary/bun",
}
# Loopback calls to the local service must never go through a proxy.
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
LANG = "zh"


def tr(zh, en):
    return zh if LANG == "zh" else en


# ---------------------------------------------------------------- config

DEFAULTS = {
    "state_dir": "~/matos-data",
    "web_port": "17474",
    "daemon_port": "17473",
    "deepseek_api_key": "",
    "deepseek_base_url": "",
    "model": "deepseek-flash",
    "env_file": "~/.config/matos/matos.env",
    "autostart": "none",
    "toolchain_dir": "~/.local/share/matos/toolchain",
    "npm_registry": "",
    "node_mirror": "",
    "bun_mirror": "",
    "toolchain_root": "",
    "conda_envs_path": "",
    "mlip_model_root": "",
}

TEMPLATE = """# MatOS 部署配置 / MatOS deployment settings
# 填好后运行 ./deploy.sh。每一项的说明见 docs/deploy.md 第 3 节。
# Fill this in, then run ./deploy.sh. See docs/deploy.md, section 3.
[matos]
# 数据目录：项目、对话、资产版本和运行记录。升级或重装程序不会改动它。
# Data directory for projects, conversations, asset versions and run records.
state_dir = {state_dir}

# 网页端口和后台端口。服务只监听本机 127.0.0.1，远程访问用 SSH 隧道。
# Web and daemon ports. The service listens on 127.0.0.1 only.
web_port = {web_port}
daemon_port = {daemon_port}

# DeepSeek API Key。可以留空，部署后在网页 设置 → 执行模式 里填写并验证。
# DeepSeek API key. May stay empty; enter it later in Settings → Execution mode.
deepseek_api_key = {deepseek_api_key}
# 企业内部兼容网关地址；用官方接口时留空。
# Compatible gateway URL; leave empty for the official API.
deepseek_base_url = {deepseek_base_url}
model = {model}
# 保存模型密钥的文件，部署时自动写入，权限 600。
# Where the model key is stored (written by deploy, mode 600).
env_file = {env_file}

# 开机自启：none（不自启）、cron（推荐，不需要 root）、systemd-user。
# Autostart: none, cron (recommended without root) or systemd-user.
autostart = {autostart}

# Node 24 和 Bun 不匹配时自动下载到这里，不需要 root。
# A private Node 24 and Bun are downloaded here when the system ones do not match.
toolchain_dir = {toolchain_dir}

# 下载镜像，国内网络慢时可填（./deploy.sh init 可一键选择 npmmirror）。
# Download mirrors; leave empty for the official sources.
npm_registry = {npm_registry}
node_mirror = {node_mirror}
bun_mirror = {bun_mirror}

# 科学计算环境（可选）：工具目录、conda 环境目录、MLIP 模型目录。
# Optional scientific storage: tool root, conda envs path, MLIP model root.
toolchain_root = {toolchain_root}
conda_envs_path = {conda_envs_path}
mlip_model_root = {mlip_model_root}
"""


def load_config(path):
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_dict({"matos": DEFAULTS})
    if path.exists():
        parser.read(path, encoding="utf-8")
    values = dict(parser["matos"])
    for key in DEFAULTS:
        values[key] = values.get(key, "").strip()
    return values


def write_config(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    stage = path.with_name(path.name + ".pending")
    stage.write_text(TEMPLATE.format(**{**DEFAULTS, **values}), encoding="utf-8")
    stage.chmod(0o600)
    os.replace(stage, path)


def expand(value):
    return Path(os.path.expandvars(os.path.expanduser(value))).resolve() if value else None


def validate_config(cfg):
    errors = []
    for key in ("web_port", "daemon_port"):
        if not cfg[key].isdigit() or not 1024 <= int(cfg[key]) <= 65535:
            errors.append(tr(f"{key} 必须是 1024–65535 之间的端口号", f"{key} must be a port between 1024 and 65535"))
    if cfg["web_port"] == cfg["daemon_port"]:
        errors.append(tr("web_port 和 daemon_port 不能相同", "web_port and daemon_port must differ"))
    if cfg["autostart"] not in ("none", "cron", "systemd-user"):
        errors.append(tr("autostart 只能是 none、cron 或 systemd-user", "autostart must be none, cron or systemd-user"))
    if not cfg["state_dir"]:
        errors.append(tr("state_dir 不能为空", "state_dir must not be empty"))
    elif expand(cfg["state_dir"]) == ROOT or ROOT in expand(cfg["state_dir"]).parents:
        errors.append(tr("state_dir 不能放在程序目录里，否则升级时会被一起替换", "state_dir must be outside the program directory"))
    if not re.fullmatch(r"[A-Za-z0-9._:/+-]{1,128}", cfg["model"] or "x"):
        errors.append(tr("model 名称格式不正确", "model name is not valid"))
    if cfg["deepseek_api_key"] and re.search(r"\s", cfg["deepseek_api_key"]):
        errors.append(tr("deepseek_api_key 里不能有空格", "deepseek_api_key must not contain spaces"))
    return errors


def ask(question, default=""):
    suffix = f" [{default}]" if default else ""
    answer = input(f"{question}{suffix}: ").strip()
    return answer or default


def interactive_init(path, cfg):
    print(tr("回答几个问题生成 " + str(path) + "（直接回车用默认值）。",
             "Answer a few questions to create " + str(path) + " (Enter keeps the default)."))
    cfg = dict(cfg)
    cfg["state_dir"] = ask(tr("数据目录", "Data directory"), cfg["state_dir"])
    web = int(cfg["web_port"]) if cfg["web_port"].isdigit() else 17474
    if not port_free(web):
        web = next_free_port(web)
    cfg["web_port"] = ask(tr("网页端口", "Web port"), str(web))
    daemon = int(cfg["daemon_port"]) if cfg["daemon_port"].isdigit() else int(cfg["web_port"]) - 1
    if not port_free(daemon) or str(daemon) == cfg["web_port"]:
        daemon = next_free_port(int(cfg["web_port"]) + 1, avoid={int(cfg["web_port"])})
    cfg["daemon_port"] = ask(tr("后台端口", "Daemon port"), str(daemon))
    key = getpass.getpass(tr("DeepSeek API Key（输入不显示；回车跳过，之后在网页里填）: ",
                             "DeepSeek API key (hidden; Enter to skip and set it in the web page later): ")).strip()
    if key:
        cfg["deepseek_api_key"] = key
    cfg["deepseek_base_url"] = ask(tr("企业网关地址（用官方接口直接回车）", "Gateway URL (Enter for the official API)"),
                                   cfg["deepseek_base_url"])
    cfg["autostart"] = ask(tr("开机自启 none / cron / systemd-user", "Autostart none / cron / systemd-user"),
                           cfg["autostart"])
    mirror = ask(tr("使用国内镜像（npmmirror）加速下载？y/N", "Use the npmmirror download mirrors? y/N"), "N")
    if mirror.lower().startswith("y"):
        cfg.update(CHINA_MIRRORS)
    errors = validate_config(cfg)
    if errors:
        raise SystemExit("\n".join(errors))
    write_config(path, cfg)
    print(tr(f"已写入 {path}（权限 600）。", f"Wrote {path} (mode 600)."))
    return cfg


# ---------------------------------------------------------------- checks

OK, WARN, FAIL = "ok", "warn", "fail"


def result(code, title, status, detail, fix=""):
    return {"code": code, "title": title, "status": status, "detail": detail, "fix": fix}


def port_free(port, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def next_free_port(start, avoid=()):
    for port in range(start, min(start + 200, 65535)):
        if port not in avoid and port_free(port):
            return port
    return start


def command_version(command, args=("--version",)):
    path = shutil.which(command)
    if not path:
        return None, None
    try:
        out = subprocess.run([path, *args], capture_output=True, text=True, timeout=20)
        return path, (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr).strip() else ""
    except (OSError, subprocess.TimeoutExpired):
        return path, ""


def glibc_version():
    try:
        name = os.confstr("CS_GNU_LIBC_VERSION") or ""
    except (ValueError, OSError):
        name = ""
    match = re.search(r"glibc\s+(\d+)\.(\d+)", name)
    if match:
        return int(match.group(1)), int(match.group(2))
    try:
        out = subprocess.run(["ldd", "--version"], capture_output=True, text=True, timeout=10)
        if "musl" in (out.stdout + out.stderr).lower():
            return "musl"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def os_release():
    try:
        data = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
        return data.get("PRETTY_NAME", "").strip('"')
    except OSError:
        return ""


def machine_arch():
    machine = platform.machine().lower()
    return {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)


def cpu_has_avx2():
    try:
        return " avx2" in Path("/proc/cpuinfo").read_text()
    except OSError:
        return True


def bun_asset_name(arch, avx2):
    if arch == "arm64":
        return "bun-linux-aarch64"
    return "bun-linux-x64" if avx2 else "bun-linux-x64-baseline"


def existing_parent(path):
    while not path.exists() and path != path.parent:
        path = path.parent
    return path


def free_gib(path):
    return shutil.disk_usage(existing_parent(path)).free / 1024**3


def mem_total_gib():
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) / 1024**2
    except (OSError, ValueError, IndexError):
        pass
    return None


def http_json(url, timeout=15, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": "matos-deploy", "Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response), None
    except urllib.error.HTTPError as error:
        return error.code, None, None
    except (urllib.error.URLError, OSError, ValueError) as error:
        return None, None, str(getattr(error, "reason", error))


def http_status(url, timeout=12, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": "matos-deploy", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, None
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, OSError, ValueError) as error:
        return None, str(getattr(error, "reason", error))


def toolchain_paths(cfg):
    base = expand(cfg["toolchain_dir"])
    arch = machine_arch() or "x64"
    return {
        "node": base / f"node-v{NODE_VERSION}-linux-{arch}" / "bin",
        "bun": base / f"bun-v{BUN_VERSION}" / "bin",
    }


def node_status(cfg):
    private = toolchain_paths(cfg)["node"] / "node"
    if private.exists():
        return "private", str(private)
    path, version = command_version("node")
    if path and re.match(r"v24\.", version or ""):
        return "system", f"{path} {version}"
    return "download", f"{path} {version}" if path else ""


def bun_status(cfg):
    private = toolchain_paths(cfg)["bun"] / "bun"
    if private.exists():
        return "private", str(private)
    path, version = command_version("bun")
    if path and (version or "").strip() == BUN_VERSION:
        return "system", f"{path} {version}"
    return "download", f"{path} {version}" if path else ""


def service_status(cfg):
    state = expand(cfg["state_dir"])
    if not state or not (state / ".service" / "status.json").exists():
        return {"supervisorAlive": False}
    out = subprocess.run([sys.executable, str(ROOT / "scripts/matos-service.py"), "status", "--state-dir", str(state)],
                         capture_output=True, text=True, timeout=30)
    try:
        return json.loads(out.stdout)
    except ValueError:
        return {"supervisorAlive": False}


def run_checks(cfg, network=True):
    checks = []
    system = platform.system()
    checks.append(result("C01", tr("操作系统", "Operating system"),
                         OK if system == "Linux" else FAIL,
                         f"{system} {os_release()}".strip(),
                         tr("目前只支持 Linux。", "Only Linux is supported.")))
    arch = machine_arch()
    checks.append(result("C02", tr("CPU 架构", "CPU architecture"),
                         OK if arch == "x64" else WARN if arch == "arm64" else FAIL,
                         platform.machine() + ("" if arch != "x64" or cpu_has_avx2() else tr("（无 AVX2，将使用 Bun baseline 版本）", " (no AVX2; the Bun baseline build is used)")),
                         tr("x86_64 已完整验证；ARM64 可以尝试，但原生依赖和 DSH 运行时未经完整验证。",
                            "x86_64 is fully validated; ARM64 may work but is not fully validated.")))
    libc = glibc_version()
    if libc == "musl":
        checks.append(result("C03", "glibc", FAIL, "musl libc",
                             tr("Alpine 等 musl 系统不受支持，请换用 Ubuntu、Debian、RHEL/Rocky 等 glibc 发行版。",
                                "musl systems such as Alpine are not supported; use a glibc distribution.")))
    elif libc is None:
        checks.append(result("C03", "glibc", WARN, tr("无法识别", "unknown"), ""))
    else:
        checks.append(result("C03", "glibc", OK if libc >= (2, 28) else FAIL, f"{libc[0]}.{libc[1]}",
                             tr("Node 24 需要 glibc 2.28 或更高（Ubuntu 20.04+、Debian 10+、RHEL/Rocky 8+）。请换用更新的系统。",
                                "Node 24 needs glibc 2.28+ (Ubuntu 20.04+, Debian 10+, RHEL/Rocky 8+).")))
    checks.append(result("C04", "Python", OK if sys.version_info >= (3, 9) else FAIL, sys.version.split()[0],
                         tr("需要 Python 3.9 或更高版本。", "Python 3.9 or newer is required.")))
    git_path, git_version = command_version("git")
    checks.append(result("C05", "Git", OK if git_path else FAIL, git_version or tr("未找到", "not found"),
                         tr("Ubuntu/Debian: sudo apt install git；RHEL/Rocky/麒麟: sudo yum install git；没有 root 时请管理员安装，或 conda install -c conda-forge git。",
                            "Install git (apt/yum install git, or conda install -c conda-forge git).")))
    cc = shutil.which("gcc") or shutil.which("cc")
    cxx = shutil.which("g++") or shutil.which("c++")
    make = shutil.which("make")
    missing = [name for name, found in (("gcc", cc), ("g++", cxx), ("make", make)) if not found]
    checks.append(result("C06", tr("C/C++ 编译器和 make", "C/C++ compiler and make"),
                         FAIL if missing else OK,
                         tr("缺少 ", "missing ") + ", ".join(missing) if missing else ", ".join(filter(None, (cc, cxx, make))),
                         tr("用于编译原生依赖。Ubuntu/Debian: sudo apt install build-essential；RHEL/Rocky/麒麟: sudo yum groupinstall 'Development Tools'；没有 root：conda install -c conda-forge gcc gxx make。",
                            "Needed for native dependencies: apt install build-essential, yum groupinstall 'Development Tools', or conda install -c conda-forge gcc gxx make.")))
    node_mode, node_detail = node_status(cfg)
    checks.append(result("C07", "Node.js 24", OK if node_mode != "download" else WARN,
                         {"private": tr("使用私有 Node ", "private Node ") + node_detail,
                          "system": tr("使用系统 Node ", "system Node ") + node_detail,
                          "download": tr(f"将自动下载 Node {NODE_VERSION} 到 toolchain_dir（不需要 root）", f"Node {NODE_VERSION} will be downloaded to toolchain_dir (no root needed)") +
                          (tr("；当前 ", "; found ") + node_detail if node_detail else "")}[node_mode]))
    bun_mode, bun_detail = bun_status(cfg)
    checks.append(result("C08", f"Bun {BUN_VERSION}", OK if bun_mode != "download" else WARN,
                         {"private": tr("使用私有 Bun ", "private Bun ") + bun_detail,
                          "system": tr("使用系统 Bun ", "system Bun ") + bun_detail,
                          "download": tr(f"将自动下载 Bun {BUN_VERSION} 到 toolchain_dir（不需要 root）", f"Bun {BUN_VERSION} will be downloaded to toolchain_dir (no root needed)") +
                          (tr("；当前 ", "; found ") + bun_detail if bun_detail else "")}[bun_mode]))
    installed = install_stamp_current()
    need = 0.5 if installed else 4
    gib = free_gib(ROOT)
    checks.append(result("C09", tr("程序目录磁盘空间", "Disk space (program directory)"),
                         OK if gib >= need else WARN if gib >= need / 2 else FAIL,
                         tr(f"{ROOT} 剩余 {gib:.1f} GiB（安装约需 3 GiB）", f"{gib:.1f} GiB free at {ROOT} (install takes about 3 GiB)"),
                         tr("清理磁盘，或把程序放到空间更大的位置。", "Free disk space or move the program to a larger disk.")))
    state = expand(cfg["state_dir"])
    if state:
        gib = free_gib(state)
        checks.append(result("C10", tr("数据目录磁盘空间", "Disk space (data directory)"),
                             OK if gib >= 2 else WARN if gib >= 1 else FAIL,
                             tr(f"{state} 剩余 {gib:.1f} GiB", f"{gib:.1f} GiB free at {state}"),
                             tr("数据目录会随项目和计算结果增长，建议放在大容量磁盘上。", "The data directory grows with projects and results; use a large disk.")))
    mem = mem_total_gib()
    if mem is not None:
        checks.append(result("C11", tr("内存", "Memory"), OK if mem >= 4 else WARN if mem >= 2 else FAIL, f"{mem:.1f} GiB",
                             tr("安装时构建前端需要约 2–4 GiB 内存；内存不足可能被系统终止（Killed）。",
                                "Building the web app needs about 2–4 GiB; with less, the build may be killed.")))
    running = service_status(cfg).get("supervisorAlive")
    for key in ("web_port", "daemon_port"):
        port = int(cfg[key]) if cfg[key].isdigit() else 0
        free = port_free(port) if port else False
        checks.append(result("C12", tr("端口 ", "Port ") + str(port),
                             OK if free or running else FAIL,
                             tr("可用", "free") if free else tr("被本实例使用（重新部署会重启服务）", "used by this instance (redeploy restarts it)") if running else tr("已被其他程序占用", "in use by another program"),
                             tr(f"在配置里换一个端口，或用 ss -ltnp | grep :{port} 找出占用的程序。",
                                f"Choose another port in the config, or find the owner with ss -ltnp | grep :{port}.")))
    if cfg["autostart"] == "systemd-user":
        ok = subprocess.run(["systemctl", "--user", "show-environment"], capture_output=True, timeout=10).returncode == 0 if shutil.which("systemctl") else False
        checks.append(result("C17", tr("开机自启（systemd 用户服务）", "Autostart (systemd user service)"), OK if ok else FAIL,
                             tr("可用", "available") if ok else tr("当前会话无法使用 systemctl --user", "systemctl --user is not usable in this session"),
                             tr("改用 autostart = cron，或请管理员开启用户服务。", "Use autostart = cron, or ask an administrator to enable user services.")))
    elif cfg["autostart"] == "cron":
        checks.append(result("C17", tr("开机自启（cron）", "Autostart (cron)"), OK if shutil.which("crontab") else FAIL,
                             shutil.which("crontab") or tr("未找到 crontab", "crontab not found"),
                             tr("安装 cron（cronie），或改用 autostart = none 并手动启动。", "Install cron, or use autostart = none.")))
    if os.geteuid() == 0:
        checks.append(result("C18", tr("运行账户", "Account"), WARN, "root",
                             tr("可以运行，但建议用专用的普通账户部署和运行 MatOS。", "Works, but a dedicated regular account is recommended.")))
    if network:
        checks.extend(network_checks(cfg, node_mode == "download", bun_mode == "download"))
    return checks


def network_checks(cfg, need_node, need_bun):
    checks = []
    proxy_fix = tr("检查网络；需要代理时先 export https_proxy=http://代理地址:端口 再运行；国内网络可运行 ./deploy.sh init 选择 npmmirror 镜像。",
                   "Check the network; export https_proxy for a proxy, or choose the npmmirror mirrors with ./deploy.sh init.")
    registry = (cfg["npm_registry"] or DEFAULT_REGISTRY).rstrip("/") + "/"
    status, error = http_status(registry)
    checks.append(result("C13", tr("npm 依赖源", "npm registry"), OK if status else FAIL,
                         f"{registry} → " + (tr(f"可访问（HTTP {status}）", f"reachable (HTTP {status})") if status else str(error)), proxy_fix))
    arch = machine_arch() or "x64"
    if need_node:
        url = f"{(cfg['node_mirror'] or DEFAULT_NODE_MIRROR).rstrip('/')}/v{NODE_VERSION}/SHASUMS256.txt"
        status, error = http_status(url)
        checks.append(result("C14", tr("Node 下载源", "Node download"), OK if status == 200 else FAIL, f"{url} → {status or error}", proxy_fix))
    if need_bun:
        url = f"{(cfg['bun_mirror'] or DEFAULT_BUN_MIRROR).rstrip('/')}/bun-v{BUN_VERSION}/SHASUMS256.txt"
        status, error = http_status(url)
        checks.append(result("C14", tr("Bun 下载源", "Bun download"), OK if status == 200 else FAIL, f"{url} → {status or error}", proxy_fix))
    base = cfg["deepseek_base_url"] or DEFAULT_MODEL_URL
    status, error = http_status(base)
    checks.append(result("C15", tr("模型服务", "Model service"), OK if status else FAIL,
                         f"{base} → " + (tr(f"可访问（HTTP {status}）", f"reachable (HTTP {status})") if status else str(error)),
                         tr("服务器访问不到模型接口；检查网络、代理，或企业网关地址是否正确。",
                            "The model endpoint is unreachable; check the network, proxy or gateway URL.")))
    key = cfg["deepseek_api_key"]
    if not key:
        checks.append(result("C16", "API Key", WARN, tr("未填写，部署后在网页 设置 → 执行模式 里填写", "not set; enter it later in Settings → Execution mode")))
    elif not cfg["deepseek_base_url"] or "api.deepseek.com" in cfg["deepseek_base_url"]:
        status, data, error = http_json("https://api.deepseek.com/user/balance", headers={"Authorization": "Bearer " + key})
        if status == 200 and isinstance(data, dict):
            balance = ", ".join(f"{item.get('total_balance')} {item.get('currency')}" for item in data.get("balance_infos") or [])
            if data.get("is_available"):
                checks.append(result("C16", "API Key", OK, tr(f"有效，余额 {balance}", f"valid, balance {balance}")))
            else:
                checks.append(result("C16", "API Key", WARN, tr(f"Key 有效，但余额不足（{balance}）", f"valid, but the balance is used up ({balance})"),
                                     tr("可以继续部署，但充值之前无法对话：platform.deepseek.com。", "Deployment can continue; top up at platform.deepseek.com before chatting.")))
        elif status == 401:
            checks.append(result("C16", "API Key", FAIL, tr("无效（401）", "invalid (401)"),
                                 tr("到 platform.deepseek.com 复制正确的 Key，修改配置后重新运行。", "Copy a valid key from platform.deepseek.com.")))
        elif status == 402:
            checks.append(result("C16", "API Key", WARN, tr("余额不足（402）", "insufficient balance (402)"),
                                 tr("Key 有效但余额不足，充值后才能对话。", "The key works but the balance is empty.")))
        else:
            checks.append(result("C16", "API Key", WARN, tr(f"无法确认（{status or error}）", f"could not verify ({status or error})"),
                                 tr("部署结束时会再通过服务实际调用一次模型。", "Deployment verifies it again through the service.")))
    else:
        checks.append(result("C16", "API Key", OK, tr("已填写（企业网关，部署结束时实际验证）", "set (gateway; verified after start)")))
    return checks


def print_checks(checks):
    marks = {OK: "[ OK ]", WARN: "[WARN]", FAIL: "[FAIL]"}
    for item in sorted(checks, key=lambda entry: entry["code"]):
        print(f"{marks[item['status']]} {item['code']} {item['title']}: {item['detail']}")
        if item["status"] != OK and item["fix"]:
            print("         " + tr("处理：", "Fix: ") + item["fix"])
    failed = [item for item in checks if item["status"] == FAIL]
    if failed:
        print(tr(f"\n有 {len(failed)} 项未通过。按上面的提示处理后重新运行；每个编号的详细说明见 {GUIDE} 第 6 节。",
                 f"\n{len(failed)} check(s) failed. Fix them and rerun; {GUIDE} section 6 explains each code."))
    return not failed


# ---------------------------------------------------------------- toolchain

def download(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "matos-deploy"})
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as out:
                total = int(response.headers.get("Content-Length") or 0)
                done, shown = 0, -10
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    if total and done * 100 // total >= shown + 10:
                        shown = done * 100 // total
                        print(f"    {target.name}: {shown}%", flush=True)
            os.replace(partial, target)
            return
        except (urllib.error.URLError, OSError) as error:
            last_error = error
            time.sleep(2 * (attempt + 1))
    raise DeployError("I01", tr(f"下载失败：{url}（{last_error}）", f"Download failed: {url} ({last_error})"))


def expected_sha256(sums_url, file_name):
    request = urllib.request.Request(sums_url, headers={"User-Agent": "matos-deploy"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as error:
        raise DeployError("I01", tr(f"下载校验文件失败：{sums_url}（{error}）", f"Could not download {sums_url} ({error})"))
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == file_name:
            return parts[0]
    raise DeployError("I02", tr(f"校验文件里没有 {file_name}", f"{file_name} is missing from {sums_url}"))


def verify_sha256(path, digest):
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            sha.update(chunk)
    if sha.hexdigest() != digest:
        path.unlink(missing_ok=True)
        raise DeployError("I02", tr(f"{path.name} 校验值不符，文件可能损坏或被篡改", f"{path.name} failed its checksum"))


def ensure_node(cfg):
    mode, _ = node_status(cfg)
    if mode != "download":
        return
    arch = machine_arch() or "x64"
    name = f"node-v{NODE_VERSION}-linux-{arch}"
    base = (cfg["node_mirror"] or DEFAULT_NODE_MIRROR).rstrip("/") + f"/v{NODE_VERSION}"
    archive = expand(cfg["toolchain_dir"]) / "downloads" / f"{name}.tar.xz"
    print(tr(f"  下载 Node {NODE_VERSION} …", f"  Downloading Node {NODE_VERSION} …"), flush=True)
    digest = expected_sha256(base + "/SHASUMS256.txt", archive.name)
    if not archive.exists():
        download(f"{base}/{archive.name}", archive)
    verify_sha256(archive, digest)
    target = expand(cfg["toolchain_dir"])
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise DeployError("I02", tr("Node 压缩包含有不安全的路径", "unsafe path in the Node archive"))
        # The data filter (Python 3.12+, security backports) also rejects
        # links that leave the target.
        tar.extractall(target, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
    print(tr(f"  Node 已安装到 {target / name}", f"  Node installed in {target / name}"))


def ensure_bun(cfg):
    mode, _ = bun_status(cfg)
    if mode != "download":
        return
    asset = bun_asset_name(machine_arch() or "x64", cpu_has_avx2())
    base = (cfg["bun_mirror"] or DEFAULT_BUN_MIRROR).rstrip("/") + f"/bun-v{BUN_VERSION}"
    archive = expand(cfg["toolchain_dir"]) / "downloads" / f"{asset}-{BUN_VERSION}.zip"
    print(tr(f"  下载 Bun {BUN_VERSION}（{asset}）…", f"  Downloading Bun {BUN_VERSION} ({asset}) …"), flush=True)
    digest = expected_sha256(base + "/SHASUMS256.txt", f"{asset}.zip")
    if not archive.exists():
        download(f"{base}/{asset}.zip", archive)
    verify_sha256(archive, digest)
    bin_dir = toolchain_paths(cfg)["bun"]
    bin_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        with zf.open(f"{asset}/bun") as source, (bin_dir / "bun.part").open("wb") as out:
            shutil.copyfileobj(source, out)
    (bin_dir / "bun.part").chmod(0o755)
    os.replace(bin_dir / "bun.part", bin_dir / "bun")
    print(tr(f"  Bun 已安装到 {bin_dir}", f"  Bun installed in {bin_dir}"))


def runtime_env(cfg):
    env = os.environ.copy()
    paths = toolchain_paths(cfg)
    prefix = [str(paths[name]) for name in ("node", "bun") if (paths[name] / name).exists()]
    env["PATH"] = os.pathsep.join(prefix + [env.get("PATH", "/usr/bin:/bin")])
    return env


# ---------------------------------------------------------------- install

class DeployError(Exception):
    def __init__(self, code, message, log_path=None):
        super().__init__(message)
        self.code = code
        self.log_path = log_path


SETUP_PATTERNS = [
    ("I05", r"ENOSPC|No space left on device"),
    ("C03", r"GLIBC_[0-9.]+'? not found|version `GLIBC"),
    ("C11", r"JavaScript heap out of memory|\bKilled\b"),
    ("I04", r"gyp ERR|node-gyp|make: \*\*\*|g\+\+: (command )?not found|cc: (command )?not found|not found: make|prebuild-install"),
    ("I03", r"ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|fetch failed|Failed to download|unable to get local issuer|self.signed certificate|ERR_SOCKET|request to https?://\S+ failed|error: GET https?://"),
]


def diagnose_setup_log(text):
    for code, pattern in SETUP_PATTERNS:
        if re.search(pattern, text):
            return code
    return "I06"


def source_identity():
    info = ROOT / "build-info.json"
    parts = []
    if info.exists():
        parts.append(info.read_text())
    elif (ROOT / ".git").exists():
        out = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True)
        parts.append(out.stdout.strip())
    for name in ("bun.lock", "ui/open-design/pnpm-lock.yaml", "package.json"):
        path = ROOT / name
        if path.exists():
            parts.append(hashlib.sha256(path.read_bytes()).hexdigest())
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def install_stamp_current():
    stamp = DEPLOY_DIR / "installed.json"
    built = (ROOT / "ui/open-design/apps/web/out/index.html").exists() and (ROOT / "ui/open-design/apps/daemon/dist/cli.js").exists()
    try:
        return built and json.loads(stamp.read_text()).get("source") == source_identity()
    except (OSError, ValueError):
        return False


def run_setup(cfg, force):
    if install_stamp_current() and not force:
        print(tr("  程序已安装且与当前版本一致，跳过（需要重装时加 --reinstall）。",
                 "  Already installed for this version; skipped (use --reinstall to rebuild)."))
        return
    DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
    log_path = DEPLOY_DIR / time.strftime("setup-%Y%m%d-%H%M%S.log")
    env = runtime_env(cfg)
    if cfg["npm_registry"]:
        env["npm_config_registry"] = cfg["npm_registry"]
        env["NPM_CONFIG_REGISTRY"] = cfg["npm_registry"]
        env["BUN_CONFIG_REGISTRY"] = cfg["npm_registry"]
    print(tr(f"  安装依赖并构建（首次约 3–10 分钟），完整日志：{log_path}",
             f"  Installing and building (3–10 minutes the first time); full log: {log_path}"), flush=True)
    started = time.monotonic()
    with log_path.open("w") as log:
        process = subprocess.Popen(["bash", str(ROOT / "scripts/matos-setup.sh")], cwd=ROOT, env=env,
                                   stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        last = time.monotonic()
        while process.poll() is None:
            time.sleep(2)
            if time.monotonic() - last >= 20:
                last = time.monotonic()
                tail = tail_lines(log_path, 1)
                elapsed = int(time.monotonic() - started)
                print(f"    {elapsed // 60}m{elapsed % 60:02d}s  {tail[-1][:110] if tail else ''}", flush=True)
    if process.returncode != 0:
        text = log_path.read_text(errors="replace")
        raise DeployError(diagnose_setup_log(text), tr("安装失败（matos-setup.sh 退出码 ", "Install failed (matos-setup.sh exit ") +
                          str(process.returncode) + "）", log_path)
    stamp = DEPLOY_DIR / "installed.json"
    stamp.write_text(json.dumps({"source": source_identity(), "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}) + "\n")
    elapsed = int(time.monotonic() - started)
    print(tr(f"  安装完成，用时 {elapsed // 60} 分 {elapsed % 60} 秒。", f"  Installed in {elapsed // 60}m{elapsed % 60}s."))


def tail_lines(path, count):
    try:
        with Path(path).open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 64 * 1024))
            return handle.read().decode("utf-8", "replace").splitlines()[-count:]
    except OSError:
        return []


ENV_KEYS = {
    "deepseek_api_key": "DEEPSEEK_API_KEY",
    "deepseek_base_url": "DEEPSEEK_BASE_URL",
    "model": "MATOS_DSH_MODEL",
    "toolchain_root": "MATOS_TOOLCHAIN_ROOT",
    "conda_envs_path": "MATOS_SYSTEM_CONDA_ENVS_PATH",
    "mlip_model_root": "MATOS_MLIP_MODEL_ROOT",
}


def write_env_file(cfg):
    """Update only the keys this config owns; keep anything else, and keep an
    existing key when the config leaves it empty."""
    path = expand(cfg["env_file"])
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lines = path.read_text().splitlines() if path.exists() else [
        "# Written by ./deploy.sh from matos-deploy.conf. Keep this file private (mode 600)."]
    owned = {ENV_KEYS[key]: cfg[key] for key in ENV_KEYS if cfg[key]}
    seen = set()
    output = []
    for line in lines:
        name = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if name in owned:
            output.append(f"{name}={owned[name]}")
            seen.add(name)
        else:
            output.append(line)
    output.extend(f"{name}={value}" for name, value in owned.items() if name not in seen)
    stage = path.with_name(path.name + ".pending")
    stage.write_text("\n".join(output) + "\n")
    stage.chmod(0o600)
    os.replace(stage, path)
    has_key = any(line.startswith("DEEPSEEK_API_KEY=") and line.split("=", 1)[1].strip() for line in output)
    return path, has_key


# ---------------------------------------------------------------- service

def service(cfg, action, extra=()):
    state = expand(cfg["state_dir"])
    args = [sys.executable, str(ROOT / "scripts/matos-service.py"), action, "--state-dir", str(state), *extra]
    return subprocess.run(args, capture_output=True, text=True, timeout=600, env=runtime_env(cfg))


def start_service(cfg, env_file):
    state = expand(cfg["state_dir"])
    state.mkdir(parents=True, exist_ok=True)
    out = service(cfg, "start", ["--port", cfg["web_port"], "--daemon-port", cfg["daemon_port"], "--env-file", str(env_file)])
    if out.returncode != 0:
        raise DeployError("R01", tr("服务启动失败：", "Service failed to start: ") + (out.stderr or out.stdout).strip()[-600:])


def stop_service(cfg):
    if service_status(cfg).get("supervisorAlive"):
        out = service(cfg, "stop")
        if out.returncode != 0:
            raise DeployError("R01", tr("停止服务失败：", "Could not stop the service: ") + (out.stderr or out.stdout).strip()[-600:])


def current_asset_root(profile):
    installation = ROOT / ".matos/public-installation.json"
    try:
        data = json.loads(installation.read_text())
        if data.get("profile") == profile:
            return (ROOT / data["assetRoot"]).resolve()
    except (OSError, ValueError, KeyError):
        pass
    return (ROOT / "distribution/benchmark-minimal" / ("assets" if profile == "workspace" else "benchmark-assets")).resolve()


def rebind_assets_if_moved(cfg):
    """A data directory stays bound to the asset package it was created with.
    After an upgrade into a new program directory, validate the user's assets
    against this version's package and switch the binding (service stopped)."""
    state = expand(cfg["state_dir"])
    binding = state / "asset-profile.json"
    try:
        data = json.loads(binding.read_text())
    except (OSError, ValueError):
        return
    profile = data.get("profile", "workspace")
    if profile not in ("workspace", "benchmark"):
        return
    wanted = current_asset_root(profile)
    if Path(data.get("assetRoot", "")).resolve() == wanted:
        return
    print(tr("  数据目录绑定的是另一个程序目录的资产包，正在校验并切换到当前版本…",
             "  The data directory uses another program directory's assets; validating and switching to this version…"), flush=True)
    out = subprocess.run([sys.executable, str(ROOT / "scripts/matos-state.py"), "rebind-assets", "--state-dir", str(state),
                          "--asset-root", str(wanted), "--asset-profile", profile],
                         capture_output=True, text=True, timeout=900, env=runtime_env(cfg))
    if out.returncode != 0:
        raise DeployError("R02", tr("切换资产包失败：", "Could not switch the asset package: ") + (out.stderr or out.stdout).strip()[-800:])


def wait_healthy(cfg, timeout=300):
    url = f"http://127.0.0.1:{cfg['web_port']}/api/health"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with LOCAL_HTTP.open(url, timeout=5) as response:
                if json.load(response).get("ok") is True:
                    return True
        except (OSError, ValueError):
            pass
        time.sleep(3)
    return False


def local_json(cfg, path, method="GET"):
    request = urllib.request.Request(f"http://127.0.0.1:{cfg['web_port']}{path}", method=method,
                                     headers={"Accept": "application/json", "Content-Type": "application/json"},
                                     data=b"{}" if method == "POST" else None)
    try:
        with LOCAL_HTTP.open(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return json.load(error)
        except ValueError:
            return {"ok": False, "error": f"HTTP {error.code}"}
    except (OSError, ValueError) as error:
        return {"ok": False, "error": str(error)}


def verify_model(cfg):
    """A real provider round-trip through the running service."""
    payload = local_json(cfg, "/api/matos/login/test", "POST")
    status = payload.get("status") if isinstance(payload.get("status"), dict) else {}
    if payload.get("ok") is True:
        return True, f"{status.get('model') or cfg['model']}"
    message = str(payload.get("message") or status.get("lastValidationError") or payload.get("error") or "")
    code = re.search(r"HTTP (\d{3})", message)
    if code and code.group(1) == "402":
        return False, tr("余额不足（HTTP 402），充值后即可使用", "insufficient balance (HTTP 402); top up to use it")
    if code and code.group(1) == "401":
        return False, tr("Key 无效（HTTP 401）", "invalid key (HTTP 401)")
    return False, redact(message, cfg)[:200] or tr("原因未知", "unknown reason")


def log_files(cfg):
    state = expand(cfg["state_dir"])
    files = [state / ".service/supervisor.log", state / ".service/launcher.log"]
    files += sorted(state.glob("control/*/logs/*/latest.log")) if state else []
    files += sorted(DEPLOY_DIR.glob("setup-*.log"))[-1:]
    files += sorted(DEPLOY_DIR.glob("deploy-*.log"))[-1:]
    return [path for path in files if path.exists()]


def print_log_tails(cfg, count=25):
    for path in log_files(cfg):
        if path.name.startswith("setup-"):
            continue
        lines = tail_lines(path, count)
        if lines:
            print(f"\n--- {path} ---")
            print(redact("\n".join(lines), cfg))


# ---------------------------------------------------------------- autostart

def autostart_id(cfg):
    return hashlib.sha256(str(expand(cfg["state_dir"])).encode()).hexdigest()[:10]


def cron_line(cfg, path_env):
    state = expand(cfg["state_dir"])
    command = shlex.join([sys.executable, str(ROOT / "scripts/matos-service.py"), "start", "--state-dir", str(state)])
    log = shlex.quote(str(state / ".service/cron.log"))
    return f"@reboot PATH={shlex.quote(path_env)} {command} >> {log} 2>&1 # matos-deploy:{autostart_id(cfg)}"


def replace_cron(existing, cfg, line):
    marker = f"# matos-deploy:{autostart_id(cfg)}"
    kept = [entry for entry in existing.splitlines() if not entry.rstrip().endswith(marker)]
    if line:
        kept.append(line)
    return "\n".join(kept).strip("\n") + "\n" if kept else ""


def systemd_unit_path(cfg):
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "systemd/user" / f"matos-{autostart_id(cfg)}.service"


def systemd_unit(cfg, path_env):
    state = expand(cfg["state_dir"])
    service_py = str(ROOT / "scripts/matos-service.py")
    return "\n".join([
        "[Unit]", f"Description=MatOS ({state})", "After=network-online.target", "",
        "[Service]", "Type=simple",
        "ExecStart=" + shlex.join([sys.executable, service_py, "run", "--state-dir", str(state)]),
        "ExecStop=" + shlex.join([sys.executable, service_py, "stop", "--state-dir", str(state)]),
        "Restart=on-failure", "RestartSec=5", "KillMode=process", "TimeoutStopSec=270",
        f"Environment=PATH={path_env}", "",
        "[Install]", "WantedBy=default.target", "",
    ])


def configure_autostart(cfg):
    mode = cfg["autostart"]
    path_env = runtime_env(cfg)["PATH"]
    notes = []
    if shutil.which("crontab"):
        current = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
        existing = current.stdout if current.returncode == 0 else ""
        wanted = replace_cron(existing, cfg, cron_line(cfg, path_env) if mode == "cron" else "")
        if wanted != existing:
            done = subprocess.run(["crontab", "-"], input=wanted, capture_output=True, text=True)
            if done.returncode != 0:
                raise DeployError("A01", tr("写入 crontab 失败：", "Could not update crontab: ") + done.stderr.strip())
    unit = systemd_unit_path(cfg)
    systemctl = shutil.which("systemctl")
    if mode == "systemd-user":
        unit.parent.mkdir(parents=True, exist_ok=True)
        unit.write_text(systemd_unit(cfg, path_env))
        stop_service(cfg)
        for args in (["daemon-reload"], ["enable", "--now", unit.name]):
            done = subprocess.run([systemctl, "--user", *args], capture_output=True, text=True)
            if done.returncode != 0:
                raise DeployError("A01", "systemctl --user " + " ".join(args) + ": " + done.stderr.strip())
        linger = subprocess.run(["loginctl", "show-user", getpass.getuser(), "--property=Linger"],
                                capture_output=True, text=True) if shutil.which("loginctl") else None
        if not linger or "Linger=yes" not in linger.stdout:
            notes.append(tr(f"systemd 用户服务在你退出登录后会停止，开机也不会自动启动，除非管理员执行：sudo loginctl enable-linger {getpass.getuser()}。不想找管理员可改用 autostart = cron。",
                            f"User services stop at logout and do not start at boot unless an administrator runs: sudo loginctl enable-linger {getpass.getuser()}. Otherwise use autostart = cron."))
    elif unit.exists() and systemctl:
        subprocess.run([systemctl, "--user", "disable", "--now", unit.name], capture_output=True)
        unit.unlink()
        subprocess.run([systemctl, "--user", "daemon-reload"], capture_output=True)
    return notes


# ---------------------------------------------------------------- report

def redact(text, cfg=None):
    text = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "sk-***", text)
    text = re.sub(r"(?i)(api[_-]?key|token|secret|password)(\s*[=:]\s*)\S+", r"\1\2***", text)
    if cfg and cfg.get("deepseek_api_key"):
        text = text.replace(cfg["deepseek_api_key"], "***")
    return text


def make_report(cfg, config_path):
    DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
    report = DEPLOY_DIR / time.strftime("report-%Y%m%d-%H%M%S.tar.gz")
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / "matos-report"
        folder.mkdir()
        checks = run_checks(cfg)
        (folder / "checks.json").write_text(json.dumps(checks, ensure_ascii=False, indent=2))
        (folder / "service-status.json").write_text(json.dumps(service_status(cfg), indent=2))
        versions = {
            "os": os_release(), "kernel": platform.release(), "machine": platform.machine(),
            "python": sys.version, "node": command_version("node")[1], "bun": command_version("bun")[1],
            "git": command_version("git")[1], "source": (ROOT / "build-info.json").read_text() if (ROOT / "build-info.json").exists() else "",
        }
        (folder / "versions.json").write_text(json.dumps(versions, indent=2))
        if config_path.exists():
            (folder / "matos-deploy.conf").write_text(redact(re.sub(r"(?m)^(deepseek_api_key\s*=\s*)\S+", r"\1***", config_path.read_text()), cfg))
        for path in log_files(cfg):
            lines = tail_lines(path, 400)
            (folder / (path.parent.name + "-" + path.name)).write_text(redact("\n".join(lines), cfg))
        with tarfile.open(report, "w:gz") as tar:
            tar.add(folder, arcname="matos-report")
    report.chmod(0o600)
    return report


# ---------------------------------------------------------------- commands

def explain_failure(error, cfg):
    print(tr(f"\n[FAIL] {error.code}: {error}", f"\n[FAIL] {error.code}: {error}"))
    if error.log_path:
        print(tr("最后几行日志：", "Last log lines:"))
        print(redact("\n".join(tail_lines(error.log_path, 30)), cfg))
        print(tr(f"完整日志：{error.log_path}", f"Full log: {error.log_path}"))
    hints = {
        "I01": tr("下载失败：检查网络或代理，国内网络可在配置里填 npmmirror 镜像。", "Download failed: check the network or proxy, or use the npmmirror mirrors."),
        "I02": tr("文件校验失败：删除 toolchain_dir/downloads 后重试。", "Checksum failed: delete toolchain_dir/downloads and retry."),
        "I03": tr("安装依赖时网络出错：检查代理（https_proxy），或在配置里填 npm_registry = https://registry.npmmirror.com 后重试。", "Network error while installing: check https_proxy or set npm_registry to a mirror."),
        "I04": tr("原生依赖编译失败：确认已安装 gcc、g++、make（见检查项 C06）。", "Native build failed: make sure gcc, g++ and make are installed (C06)."),
        "I05": tr("磁盘已满：清理空间后重试。", "Disk full: free space and retry."),
        "C03": tr("系统的 glibc 太旧，Node 24 无法运行，需要更新的 Linux 发行版。", "glibc is too old for Node 24; use a newer distribution."),
        "C11": tr("内存不足，构建被系统终止：关闭其他程序或换内存更大的机器。", "Out of memory during the build."),
        "I06": tr("未识别的安装错误：看上面的日志，或运行 ./deploy.sh report 打包诊断信息发给协助的人。", "Unrecognized install error: read the log above or run ./deploy.sh report."),
        "R02": tr("新版本的资产包和你已有的资产不兼容，或数据目录正被使用；原来的绑定没有改动。看上面的报错，必要时联系维护者。", "The new asset package is incompatible with your assets, or the data directory is busy; nothing was switched."),
        "R01": tr("服务没有正常启动：看下面的服务日志；常见原因是端口被占用或上次安装不完整（可加 --reinstall）。", "The service did not become healthy; see the service logs below."),
        "A01": tr("开机自启设置失败，服务本身已在运行；可改用 autostart = none 后重新运行。", "Autostart setup failed; the service itself is running."),
    }
    if error.code in hints:
        print(hints[error.code])
    if error.code == "R01":
        print_log_tails(cfg)
    print(tr(f"\n编号 {error.code} 的详细说明见 {GUIDE} 第 6 节；需要别人协助时运行 ./deploy.sh report。",
             f"\n{GUIDE} section 6 explains code {error.code}; run ./deploy.sh report when asking for help."))


def summary(cfg, model_ok, model_detail, notes):
    host = socket.gethostname()
    user = getpass.getuser()
    port = cfg["web_port"]
    print(tr("\n✓ MatOS 部署完成", "\n✓ MatOS is deployed"))
    print(tr(f"  本机访问：http://127.0.0.1:{port}/", f"  Local URL: http://127.0.0.1:{port}/"))
    print(tr("  从你自己的电脑访问：在你的电脑上运行下面这行，然后打开 http://127.0.0.1:" + port + "/",
             "  From your own computer: run this there, then open http://127.0.0.1:" + port + "/"))
    print(f"      ssh -N -L {port}:127.0.0.1:{port} {user}@{host}")
    if model_ok is True:
        print(tr(f"  模型：已验证可用（{model_detail}）", f"  Model: verified ({model_detail})"))
    elif model_ok is None:
        print(tr("  模型：还没有填写 API Key。打开网页 → 右上角设置 → 设置 → 执行模式，填写后点保存，会立即验证。",
                 "  Model: no API key yet. Open the page → Settings → Execution mode, enter it and save."))
    else:
        print(tr(f"  模型：验证失败（{model_detail}）。检查 Key 和余额，或在网页 设置 → 执行模式 里重新填写。编号 R03，见 {GUIDE}。",
                 f"  Model: verification failed ({model_detail}). Check the key or re-enter it in Settings → Execution mode. Code R03, see {GUIDE}."))
    print(tr(f"  数据目录：{expand(cfg['state_dir'])}", f"  Data directory: {expand(cfg['state_dir'])}"))
    print(tr("  常用命令：./deploy.sh status | stop | start | restart | logs | check | report",
             "  Commands: ./deploy.sh status | stop | start | restart | logs | check | report"))
    print(tr(f"  使用和排错手册：{GUIDE}", f"  Guide and troubleshooting: {GUIDE}"))
    for note in notes:
        print("  ! " + note)


def confirm(question, assume_yes):
    if assume_yes or not sys.stdin.isatty():
        return True
    return input(question + " [y/N]: ").strip().lower().startswith("y")


class Tee:
    """Mirror deploy output into a redacted transcript for ./deploy.sh report."""

    def __init__(self, stream, path, cfg):
        self.stream, self.file, self.cfg = stream, path.open("a"), cfg

    def write(self, data):
        self.stream.write(data)
        self.file.write(redact(data, self.cfg))

    def flush(self):
        self.stream.flush()
        self.file.flush()


def cmd_deploy(cfg, args):
    print(tr("== 1/5 系统检查", "== 1/5 System check"))
    if not print_checks(run_checks(cfg)):
        return 1
    if service_status(cfg).get("supervisorAlive") and not confirm(
            tr("这个数据目录的服务正在运行，重新部署会重启它（正在运行的任务会中断）。继续？",
               "The service for this data directory is running; redeploying restarts it. Continue?"), args.yes):
        return 1
    print(tr("== 2/5 准备 Node 和 Bun", "== 2/5 Node and Bun"))
    ensure_node(cfg)
    ensure_bun(cfg)
    print(tr("== 3/5 安装程序", "== 3/5 Install"))
    run_setup(cfg, args.reinstall)
    print(tr("== 4/5 写入模型配置并启动服务", "== 4/5 Model settings and start"))
    env_file, has_key = write_env_file(cfg)
    print(tr(f"  模型配置已写入 {env_file}（权限 600）", f"  Model settings written to {env_file} (mode 600)"))
    stop_service(cfg)
    rebind_assets_if_moved(cfg)
    start_service(cfg, env_file)
    if not wait_healthy(cfg):
        raise DeployError("R01", tr("服务 5 分钟内没有就绪", "The service was not healthy within 5 minutes"))
    print(tr("  服务已就绪。", "  Service is healthy."))
    print(tr("== 5/5 验证模型和开机自启", "== 5/5 Model check and autostart"))
    model_ok, model_detail = (verify_model(cfg) if has_key else (None, ""))
    notes = configure_autostart(cfg)
    if cfg["autostart"] == "systemd-user" and not wait_healthy(cfg):
        raise DeployError("R01", tr("systemd 用户服务启动后没有就绪", "The systemd user service did not become healthy"))
    summary(cfg, model_ok, model_detail, notes)
    return 0


def main(argv=None):
    global LANG
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="deploy",
                        choices=["deploy", "check", "init", "start", "stop", "restart", "status", "logs", "report", "uninstall"])
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="matos-deploy.conf")
    parser.add_argument("--yes", "-y", action="store_true", help="do not ask for confirmation")
    parser.add_argument("--reinstall", action="store_true", help="rebuild even if this version is installed")
    parser.add_argument("--offline-check", action="store_true", help="check without network probes")
    parser.add_argument("--lang", choices=["zh", "en"], default=os.environ.get("MATOS_DEPLOY_LANG", "zh"))
    parser.add_argument("--lines", type=int, default=60, help="log lines for the logs command")
    args = parser.parse_args(argv)
    LANG = args.lang
    config_path = args.config.resolve()
    cfg = load_config(config_path)

    if args.command == "init" or (args.command == "deploy" and not config_path.exists()):
        if sys.stdin.isatty():
            cfg = interactive_init(config_path, cfg)
            if args.command == "init":
                print(tr("下一步：运行 ./deploy.sh", "Next: run ./deploy.sh"))
                return 0
        else:
            write_config(config_path, cfg)
            print(tr(f"已生成配置模板 {config_path}，填写后重新运行 ./deploy.sh。",
                     f"Wrote a template to {config_path}; fill it in and run ./deploy.sh again."))
            return 0 if args.command == "init" else 1
    errors = validate_config(cfg)
    if errors:
        print(tr(f"配置有误（{config_path}）：", f"Configuration errors ({config_path}):"))
        for error in errors:
            print("  - " + error)
        return 1
    if config_path.exists():
        config_path.chmod(0o600)

    try:
        if args.command == "deploy":
            DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
            sys.stdout = Tee(sys.stdout, DEPLOY_DIR / time.strftime("deploy-%Y%m%d-%H%M%S.log"), cfg)
            return cmd_deploy(cfg, args)
        if args.command == "check":
            return 0 if print_checks(run_checks(cfg, network=not args.offline_check)) else 1
        if args.command in ("start", "restart"):
            if args.command == "restart":
                stop_service(cfg)
            env_file = expand(cfg["env_file"])
            if not env_file.exists():
                env_file, _ = write_env_file(cfg)
            start_service(cfg, env_file)
            if not wait_healthy(cfg):
                raise DeployError("R01", tr("服务 5 分钟内没有就绪", "The service was not healthy within 5 minutes"))
            print(tr(f"已启动：http://127.0.0.1:{cfg['web_port']}/", f"Started: http://127.0.0.1:{cfg['web_port']}/"))
            return 0
        if args.command == "stop":
            stop_service(cfg)
            print(tr("已停止。", "Stopped."))
            return 0
        if args.command == "status":
            status = service_status(cfg)
            healthy = status.get("supervisorAlive") and status.get("state") == "healthy"
            print(tr("运行中，健康" if healthy else "运行中，正在恢复" if status.get("supervisorAlive") else "未运行",
                     "running, healthy" if healthy else "running, recovering" if status.get("supervisorAlive") else "not running"))
            print(json.dumps(status, indent=2, ensure_ascii=False))
            return 0 if healthy else 1
        if args.command == "logs":
            for path in log_files(cfg):
                print(f"\n--- {path} ---")
                print(redact("\n".join(tail_lines(path, args.lines)), cfg))
            return 0
        if args.command == "uninstall":
            if not confirm(tr("停止服务并删除开机自启？程序目录、Node/Bun 和数据目录保留，需要时手动删除。",
                              "Stop the service and remove autostart? Files and data are kept."), args.yes):
                return 1
            stop_service(cfg)
            configure_autostart({**cfg, "autostart": "none"})
            print(tr("已停止服务并删除开机自启。需要彻底删除时，手动删除：", "Stopped and removed autostart. To remove everything, delete:"))
            print(tr(f"  程序目录   {ROOT}", f"  program     {ROOT}"))
            print(tr(f"  Node/Bun   {expand(cfg['toolchain_dir'])}（其他实例可能也在用）", f"  Node/Bun    {expand(cfg['toolchain_dir'])} (may be shared)"))
            print(tr(f"  模型配置   {expand(cfg['env_file'])}", f"  model env   {expand(cfg['env_file'])}"))
            print(tr(f"  数据目录   {expand(cfg['state_dir'])}（项目和对话都在里面，确认不要了再删）", f"  data        {expand(cfg['state_dir'])} (your projects; delete only if unwanted)"))
            return 0
        if args.command == "report":
            report = make_report(cfg, config_path)
            print(tr(f"诊断包：{report}\n里面的密钥已打码；发给别人之前可以先解压看一遍。",
                     f"Diagnostics: {report}\nKeys are redacted; review it before sharing."))
            return 0
    except DeployError as error:
        explain_failure(error, cfg)
        return 1
    except KeyboardInterrupt:
        print(tr("\n已中断。重新运行 ./deploy.sh 会从断点继续。", "\nInterrupted. Run ./deploy.sh again to continue."))
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
