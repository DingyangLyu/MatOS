#!/usr/bin/env python3
"""Prepare/verify a relocatable, credential-free DSH runtime for MatOS."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

CRITICAL_FILES = ["bin/dsh", "bin/rg", "node/bin/node", "pnpm/package.json",
                  "runtime/node_modules/@deepseek-ai/dsh/package.json",
                  "profiles/sdk/package.json", "profiles/sdk/.matos-plugin-installed"]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def plugin_hashes(source):
    base = source / "vendor/deepseek-harness"
    return {str(p.relative_to(base)): digest(p)
            for name in ["matos-plugin", "matos-sdk-profile"]
            for p in sorted((base/name).iterdir())
            if p.is_file() and p.suffix in [".js", ".json", ".yml"]
            and ".test." not in p.name and not p.name.startswith(".")}

def require_clean_profile(profile):
    # A reused profile is a dependency template, never operator configuration.
    # Checking the patch alone misses credentials/plugins in the root file.
    for name in ["cordis.yml", "cordis.patch.yml"]:
        text = (profile/name).read_text()
        if "".join(line.split("#", 1)[0].strip() for line in text.splitlines()) != "[]":
            raise ValueError("Use a clean SDK template; " + name + " contains user configuration")

def host_platform():
    machine = os.uname().machine.lower()
    machine = {"amd64": "x86_64", "arm64": "aarch64"}.get(machine, machine)
    return sys.platform + "-" + machine

def probe_host(bundle):
    try:
        node = subprocess.check_output([str(bundle/"node/bin/node"), "--version"], text=True, stderr=subprocess.STDOUT, timeout=15).strip()
        subprocess.run([str(bundle/"bin/rg"), "--version"], check=True, capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("Runtime binaries cannot execute on this host; rebuild for this OS/CPU/system libraries") from error
    if not node.startswith("v24."):
        raise ValueError("The runtime requires Node 24")
    return node

def verify(bundle, source, check_host=False):
    bundle = bundle.resolve()
    meta = json.loads((bundle/"manifest.json").read_text())
    platform = meta.get("platform", "").replace("darwin-arm64", "darwin-aarch64").replace("linux-arm64", "linux-aarch64")
    if platform != host_platform():
        raise ValueError("Runtime platform mismatch: " + str(meta.get("platform")) + "; host " + host_platform() + ". Rebuild the runtime on the target host.")
    expected = json.loads((source/"vendor/deepseek-harness/VERSION.json").read_text())["version"].removeprefix("dsh-v")
    installed = json.loads((bundle/"runtime/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]
    if installed != expected or meta["dshVersion"] != expected:
        raise ValueError("DSH package version differs from the pinned MatOS release")
    hashes = plugin_hashes(source)
    if meta["pluginHashes"] != hashes:
        raise ValueError("Prepared DSH plugins differ from this MatOS source; rebuild the runtime")
    for rel in ["bin/dsh", "bin/rg", "node/bin/node", "pnpm/bin/pnpm.cjs", "profiles/sdk/.matos-plugin-installed"]:
        if not (bundle/rel).is_file():
            raise ValueError("Missing DSH distribution file: " + rel)
    require_clean_profile(bundle/"profiles/sdk")
    for rel, expected_hash in hashes.items():
        name, filename = rel.split("/", 1)
        installed_name = "dsh-assets" if name == "matos-plugin" else "dsh-sdk-profile"
        for dst in [bundle/"plugins"/rel, bundle/"profiles/sdk/node_modules/@matos"/installed_name/filename]:
            if not dst.is_file() or digest(dst) != expected_hash:
                raise ValueError("Prepared plugin is stale: " + str(dst.relative_to(bundle)))
    for directory, dirs, files in os.walk(bundle, followlinks=False):
        for name in dirs + files:
            p = Path(directory)/name
            if p.is_symlink() and (not p.exists() or not p.resolve().is_relative_to(bundle)):
                raise ValueError("Broken or external symlink in DSH distribution: " + str(p.relative_to(bundle)))
    if not set(CRITICAL_FILES).issubset(meta.get("criticalHashes", {})):
        raise ValueError("DSH distribution is missing required checksums")
    for rel, expected_hash in meta["criticalHashes"].items():
        if not (bundle/rel).resolve().is_relative_to(bundle):
            raise ValueError("Invalid DSH distribution checksum path")
        if digest(bundle/rel) != expected_hash:
            raise ValueError("DSH distribution checksum mismatch: " + rel)
    if check_host:
        if probe_host(bundle) != meta["nodeVersion"]:
            raise ValueError("Runtime Node version differs from its manifest")
    return {"ok": True, "dshVersion": expected, "nodeVersion": meta["nodeVersion"], "platform": meta["platform"]}

def prepare(args):
    source = args.source.resolve()
    out = args.output.resolve()
    if out.exists():
        raise ValueError("Output already exists; choose a new versioned directory")
    runtime_source = args.runtime_source.resolve()
    node = args.node.resolve()
    pnpm = args.pnpm_root.resolve()
    version = json.loads((source/"vendor/deepseek-harness/VERSION.json").read_text())["version"].removeprefix("dsh-v")
    installed = json.loads((runtime_source/"node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]
    if installed != version:
        raise ValueError("Runtime source is not pinned DSH " + version)
    node_version = subprocess.check_output([str(node), "--version"], text=True).strip()
    if not node_version.startswith("v24."):
        raise ValueError("The DSH distribution requires Node 24")
    if json.loads((pnpm/"package.json").read_text())["name"] != "pnpm":
        raise ValueError("--pnpm-root must be the actual pnpm package, not a Corepack shim")
    out.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".dsh-prepare-", dir=out.parent))
    try:
        (stage/"node/bin").mkdir(parents=True)
        shutil.copy2(node, stage/"node/bin/node")
        shutil.copytree(pnpm, stage/"pnpm", symlinks=True)
        shutil.copytree(runtime_source/"node_modules", stage/"runtime/node_modules", symlinks=True)
        for filename in ["package.json", "package-lock.json"]:
            if (runtime_source/filename).exists():
                shutil.copy2(runtime_source/filename, stage/"runtime"/filename)
        for name in ["matos-plugin", "matos-sdk-profile"]:
            shutil.copytree(source/"vendor/deepseek-harness"/name, stage/"plugins"/name,
                            ignore=shutil.ignore_patterns("node_modules", "*.test.*", "._*"), symlinks=True)
        (stage/"bin").mkdir()
        (stage/"bin/dsh").write_text('#!/usr/bin/env bash\nset -euo pipefail\nroot="$(cd "$(dirname "$0")/.." && pwd)"\nexport PATH="$root/node/bin:$PATH"\nexec "$root/node/bin/node" "$root/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n')
        (stage/"bin/dsh").chmod(0o755)
        node_platform = json.loads(subprocess.check_output([str(node), '-p', 'JSON.stringify({platform:process.platform,arch:process.arch})'], text=True))
        rg = stage/('runtime/node_modules/@vscode/ripgrep-' + node_platform['platform'] + '-' + node_platform['arch'] + '/bin/rg')
        if not rg.is_file(): raise ValueError('Pinned runtime is missing its platform ripgrep binary')
        (stage/'bin/rg').symlink_to(os.path.relpath(rg, stage/'bin'))
        (stage/"node/bin/node").chmod(0o755)
        build_home = stage/"build-home"
        env = {k:v for k,v in os.environ.items()
               if not re.search(r"(TOKEN|SECRET|PASSWORD|API_KEY|AUTH_TOKEN)", k, re.I)}
        env.update(PATH=str(stage/"node/bin")+os.pathsep+env.get("PATH", ""),
                   DSH_HOME=str(build_home), MATOS_DSH_HOME=str(build_home),
                   MATOS_DSH_EXEC_BIN=str(stage/"bin/dsh"), MATOS_DSH_VERSION=version,
                   MATOS_DSH_PNPM_BIN=str(stage/"pnpm/bin/pnpm.cjs"),
                   MATOS_DSH_PLUGIN_PATH=str(stage/"plugins/matos-plugin"),
                   MATOS_DSH_SDK_PLUGIN_PATH=str(stage/"plugins/matos-sdk-profile"),
                   MATOS_DSH_NATIVE_SDK="1", MATOS_DSH_OFFLINE="0",
                   MATOS_DSH_PROFILE_TEMPLATE="", COREPACK_ENABLE_NETWORK="0")
        if args.profile_template:
            original = args.profile_template.resolve()/"sdk"
            require_clean_profile(original)
            profile = stage/"profiles/sdk"
            profile.mkdir(parents=True)
            for filename in ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]:
                if (original/filename).exists(): shutil.copy2(original/filename, profile/filename)
            shutil.copytree(original/"node_modules", profile/"node_modules", symlinks=True)
            for folder, package_name in [("matos-plugin", "dsh-assets"), ("matos-sdk-profile", "dsh-sdk-profile")]:
                target = profile/"node_modules/@matos"/package_name
                desired = stage/"plugins"/folder
                old_package = json.loads((target/"package.json").read_text())
                new_package = json.loads((desired/"package.json").read_text())
                if old_package.get("dependencies") != new_package.get("dependencies"):
                    raise ValueError("Template dependencies changed; prepare a fresh profile before offline export")
                if target.is_symlink(): target.unlink()
                else: shutil.rmtree(target)
                shutil.copytree(desired, target, symlinks=True)
            hashes = []
            for folder in ["matos-plugin", "matos-sdk-profile"]:
                plugin = stage/"plugins"/folder
                hashes += [digest(plugin/"package.json")]
                hashes += [digest(p) for p in sorted(plugin.glob("*.js")) if ".test." not in p.name and not p.name.startswith(".")]
                hashes += [digest(plugin/"cordis.patch.yml")]
            stamp = hashlib.sha256((version+"\n"+"\n".join(hashes)+"\n").encode()).hexdigest()
            (profile/".matos-plugin-installed").write_text(stamp+"\n")
        else:
            with (stage/"prepare.log").open("w") as log:
                subprocess.run(["bash", str(source/"scripts/matos-dsh-launcher.sh"),
                                "--profile", "sdk", "--help"], env=env, stdout=log, stderr=log,
                               check=True, timeout=600)
            shutil.move(str(build_home/"profiles"), stage/"profiles")
            shutil.rmtree(build_home)
        # pnpm installs file: bundles as real profile-local copies. Remove
        # build-time locator metadata; startup resolves installed bundles.
        profile = stage/"profiles/sdk"
        package = json.loads((profile/"package.json").read_text())
        for name, folder in [("@matos/dsh-assets", "matos-plugin"), ("@matos/dsh-sdk-profile", "matos-sdk-profile")]:
            package["dependencies"][name] = "file:../../plugins/" + folder
        (profile/"package.json").write_text(json.dumps(package, indent=2)+"\n")
        for filename in ["pnpm-lock.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.modules.yaml"]:
            p = profile/filename
            if p.exists():
                p.write_text(p.read_text().replace(str(stage/"plugins"), "../../plugins"))
        # Build logs can contain machine-local paths and are not runtime input.
        (stage/"prepare.log").unlink(missing_ok=True)
        meta = {"schemaVersion": 1, "dshVersion": version, "nodeVersion": node_version,
                "platform": host_platform(),
                "pnpmVersion": json.loads((pnpm/"package.json").read_text())["version"],
                "pluginHashes": plugin_hashes(source),
                "criticalHashes": {p:digest(stage/p) for p in CRITICAL_FILES}}
        (stage/"manifest.json").write_text(json.dumps(meta, indent=2)+"\n")
        for directory, dirs, files in os.walk(stage, followlinks=False):
            Path(directory).chmod(0o755)
            for name in files:
                p = Path(directory)/name
                if not p.is_symlink():
                    p.chmod(p.stat().st_mode | 0o444)
        verify(stage, source, check_host=True)
        stage.rename(out)
        print(json.dumps(verify(out, source)))
    except Exception:
        print("Preserved incomplete DSH package at " + str(stage), file=sys.stderr)
        raise

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--runtime-source", type=Path, required=True)
    p.add_argument("--profile-template", type=Path, help="Clean, previously prepared SDK profiles for offline dependency reuse")
    p.add_argument("--node", type=Path, required=True)
    p.add_argument("--pnpm-root", type=Path, required=True)
    p = sub.add_parser("verify")
    p.add_argument("--bundle", type=Path, required=True)
    p.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args)
    else:
        print(json.dumps(verify(args.bundle, args.source.resolve(), check_host=True)))

if __name__ == "__main__":
    main()
