#!/usr/bin/env python3
"""Select and atomically activate validated public DSH runtime releases."""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def preparation(source):
    spec = importlib.util.spec_from_file_location('matos_dsh_prepare', source/'scripts/matos-dsh-prepare-runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def checked_path(source, relative):
    if not isinstance(relative, str):
        raise ValueError('Invalid DSH runtime selection')
    parts = Path(relative).parts
    if relative != 'runtime' and not (len(parts) == 2 and parts[0] == 'runtime-releases' and
                                      all(c in '0123456789abcdef' for c in parts[1]) and len(parts[1]) == 32):
        raise ValueError('DSH runtime selection must name a local versioned release')
    base = (source/'vendor/deepseek-harness').resolve()
    target = base/relative
    if not target.resolve().is_relative_to(base):
        raise ValueError('DSH runtime selection escapes the installation')
    return target


def selected(source, require_complete=True):
    pointer = source/'vendor/deepseek-harness/runtime-active.json'
    if not pointer.exists():
        return checked_path(source, 'runtime')
    record = json.loads(pointer.read_text())
    if record.get('schemaVersion') != 1:
        raise ValueError('Unsupported DSH runtime selection format')
    path = checked_path(source, record.get('path'))
    if require_complete and not (path/'manifest.json').is_file():
        raise ValueError('Selected DSH runtime is incomplete; run matos-setup.sh')
    return path


def activate(source, candidate, verifier):
    base = (source/'vendor/deepseek-harness').resolve()
    candidate = candidate.resolve()
    relative = str(candidate.relative_to(base))
    checked_path(source, relative)
    # No pointer or previous release is changed until full validation succeeds.
    validation = verifier(candidate, source)
    previous = selected(source, require_complete=False)
    pointer = base/'runtime-active.json'
    if previous.resolve() == candidate.resolve() and pointer.exists():
        return json.loads(pointer.read_text())
    record = {'schemaVersion': 1, 'path': relative,
              'previousPath': str(previous.relative_to(base)), 'validation': validation}
    fd, temporary = tempfile.mkstemp(prefix='.runtime-active-', suffix='.json', dir=base)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(record, out, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, base/'runtime-active.json')
    finally:
        Path(temporary).unlink(missing_ok=True)
    return record


def pinned_version(source):
    return json.loads((source/'vendor/deepseek-harness/VERSION.json').read_text())['version'].removeprefix('dsh-v')


def matches_runtime(path, version):
    try:
        package_ok = json.loads((path/'node_modules/@deepseek-ai/dsh/package.json').read_text())['version'] == version
        machine = os.uname().machine.lower()
        arch = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(machine, machine)
        rg = path/('node_modules/@vscode/ripgrep-' + sys.platform + '-' + arch + '/bin/rg')
        return package_ok and rg.is_file()
    except (OSError, ValueError, KeyError):
        return False


def reusable_template(profile_root, source, module):
    try:
        module.require_clean_profile(profile_root/'sdk')
        for directory, package in [('matos-plugin', 'dsh-assets'), ('matos-sdk-profile', 'dsh-sdk-profile')]:
            old = json.loads((profile_root/'sdk/node_modules/@matos'/package/'package.json').read_text())
            new = json.loads((source/'vendor/deepseek-harness'/directory/'package.json').read_text())
            if old.get('dependencies') != new.get('dependencies'):
                return False
        return True
    except (OSError, ValueError, KeyError):
        return False


def ensure(args):
    source = args.source.resolve()
    base = source/'vendor/deepseek-harness'
    module = preparation(source)
    # File-contract tests explicitly omit executable probes; CLI callers do not.
    validate = lambda path, source: module.verify(path, source, check_host=getattr(args, "check_host", True))
    with (base/'.runtime-update.lock').open('a') as lock:
        deadline = time.monotonic() + float(os.environ.get('MATOS_DSH_UPDATE_LOCK_TIMEOUT_SECONDS', '180'))
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise TimeoutError('Another runtime update is still active')
                time.sleep(0.1)
        current = selected(source, require_complete=False)
        try:
            validation = validate(current, source)
            if args.rebuild: raise ValueError("Explicit runtime rebuild requested")
            return {'ok': True, 'status': 'current', 'bundle': str(current), **validation}
        except (OSError, ValueError, KeyError):
            pass
        pointer = base/'runtime-active.json'
        if not args.rebuild and pointer.exists():
            previous_ref = json.loads(pointer.read_text()).get('previousPath')
            if previous_ref:
                previous = checked_path(source, previous_ref)
                try:
                    validate(previous, source)
                except (OSError, ValueError, KeyError):
                    pass
                else:
                    receipt = activate(source, previous, validate)
                    return {'ok': True, 'status': 'restored', 'bundle': str(previous), **receipt}
        version = pinned_version(source)
        try:
            prior_platform = json.loads((current/'manifest.json').read_text()).get('platform', '')
            same_host = prior_platform.replace('darwin-arm64', 'darwin-aarch64').replace('linux-arm64', 'linux-aarch64') == module.host_platform()
        except (OSError, ValueError):
            same_host = False
        runtime_source = args.runtime_source
        if runtime_source is None:
            runtime_source = current/'runtime' if same_host and matches_runtime(current/'runtime', version) else base/'runtime-deps'
        if not matches_runtime(runtime_source, version):
            if runtime_source.resolve() != (base/'runtime-deps').resolve():
                raise ValueError('The supplied runtime source does not contain the pinned DSH package')
            if os.environ.get('MATOS_DSH_OFFLINE') == '1':
                raise ValueError('Offline update needs the pinned runtime dependencies supplied in advance')
            env = dict(os.environ)
            env['PATH'] = str(args.node.resolve().parent)+os.pathsep+env.get('PATH', '')
            subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                           cwd=runtime_source, env=env, check=True, stdout=sys.stderr)
        template = args.profile_template
        if template is None and same_host and reusable_template(current/'profiles', source, module):
            template = current/'profiles'
        node_version = subprocess.check_output([str(args.node), '--version'], text=True).strip()
        pnpm_version = json.loads((args.pnpm_root/'package.json').read_text())['version']
        identity = {'dsh': version, 'plugins': module.plugin_hashes(source),
                    'node': node_version, 'pnpm': pnpm_version, 'platform': module.host_platform(),
                    'nodeBinarySha256': module.digest(args.node.resolve())}
        release_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:32]
        candidate = base/'runtime-releases'/release_id
        if candidate.exists():
            try:
                validate(candidate, source)
            except (OSError, ValueError, KeyError):
                # Preserve a damaged release for diagnosis; never repair files
                # in place while an older process may still reference them.
                repair_id = hashlib.sha256((release_id+uuid.uuid4().hex).encode()).hexdigest()[:32]
                candidate = base/'runtime-releases'/repair_id
        if not candidate.exists():
            prepare_args = argparse.Namespace(source=source, output=candidate,
                runtime_source=runtime_source, node=args.node, pnpm_root=args.pnpm_root,
                profile_template=template)
            with contextlib.redirect_stdout(io.StringIO()):
                module.prepare(prepare_args)
        receipt = activate(source, candidate, validate)
        return {'ok': True, 'status': 'updated', 'bundle': str(candidate), **receipt}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('path')
    check = sub.add_parser('verify')
    update = sub.add_parser('ensure')
    update.add_argument('--rebuild', action='store_true', help='Prepare a validated release even when the legacy bundle matches')
    update.add_argument('--runtime-source', type=Path)
    update.add_argument('--profile-template', type=Path)
    update.add_argument('--node', type=Path, required=True)
    update.add_argument('--pnpm-root', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'path':
            print(selected(args.source.resolve()))
        elif args.action == 'verify':
            print(json.dumps(preparation(args.source).verify(selected(args.source.resolve()), args.source.resolve(), check_host=True)))
        else:
            print(json.dumps(ensure(args)))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(78, 'DSH runtime update: '+str(error)+'\n')


if __name__ == '__main__':
    main()
