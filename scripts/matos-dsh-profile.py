#!/usr/bin/env python3
"""Materialize an immutable SDK profile from a verified, credential-free template."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time


def source_files(plugin, sdk):
    return [p for root in [plugin, sdk] for p in
            [root/'package.json', *sorted(root.glob('*.js')), root/'cordis.patch.yml']
            if '.test.' not in p.name and not p.name.startswith('.')]


def plugin_stamp(version, plugin, sdk):
    hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files(plugin, sdk)]
    return hashlib.sha256((version+'\n'+'\n'.join(hashes)+'\n').encode()).hexdigest()


def clean_configuration(profile, allow_missing=False):
    for name in ['cordis.yml', 'cordis.patch.yml']:
        path = profile/name
        if allow_missing and not path.exists():
            continue
        text = path.read_text()
        if ''.join(line.split('#', 1)[0].strip() for line in text.splitlines()) != '[]':
            raise ValueError(f'{profile.name}/{name} contains custom configuration; it has been preserved. Use a separate custom profile rather than replacing it with the public SDK template.')


def verify_profile(profile, expected, plugin, sdk):
    if profile.is_symlink():
        raise ValueError('An SDK profile directory must not be a symlink')
    if (profile/'.matos-plugin-installed').read_text().strip() != expected:
        raise ValueError('SDK template/profile belongs to a different MatOS plugin revision; run matos-setup.sh first')
    clean_configuration(profile)
    for source, package in [(plugin, 'dsh-assets'), (sdk, 'dsh-sdk-profile')]:
        target = profile/'node_modules/@matos'/package
        if target.is_symlink() or not target.is_dir():
            raise ValueError('SDK plugin must be a profile-local installed copy: '+package)
        for src in [source/'package.json', *sorted(source.glob('*.js')), source/'cordis.patch.yml']:
            if '.test.' in src.name or src.name.startswith('.'):
                continue
            dst = target/src.name
            if not dst.is_file() or dst.is_symlink() or dst.read_bytes() != src.read_bytes():
                raise ValueError('SDK plugin content does not match this release: '+package+'/'+src.name)


def prepare(home, template, name, version, plugin, sdk):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', name):
        raise ValueError('Invalid SDK profile name')
    expected = plugin_stamp(version, plugin, sdk)
    source = template/name
    verify_profile(source, expected, plugin, sdk)
    profiles = home/'profiles'
    profiles.mkdir(parents=True, exist_ok=True)
    if profiles.is_symlink():
        raise ValueError('The SDK profiles directory must not be a symlink')
    selected = name+'-matos-'+expected[:32]
    target = profiles/selected
    with (profiles/'.matos-profile-upgrade.lock').open('a') as lock:
        deadline = time.monotonic() + float(os.environ.get('MATOS_DSH_PROFILE_LOCK_TIMEOUT_SECONDS', '180'))
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise TimeoutError('Another SDK profile initialization is still active')
                time.sleep(0.1)
        # Old SDK profiles may contain operator settings: never silently drop them.
        legacy = profiles/name
        if legacy.exists():
            if legacy.is_symlink():
                raise ValueError('Legacy SDK profile is a symlink; no migration was performed')
            clean_configuration(legacy, allow_missing=True)
        if target.exists() or target.is_symlink():
            verify_profile(target, expected, plugin, sdk)
            return selected
        stage = Path(tempfile.mkdtemp(prefix='.'+selected+'-', dir=profiles))
        try:
            shutil.copytree(source, stage, dirs_exist_ok=True, symlinks=True,
                            ignore=shutil.ignore_patterns('.matos-plugin.lock', '.plugin-manager'))
            verify_profile(stage, expected, plugin, sdk)
            receipt = {'schemaVersion': 1, 'kind': 'matos-public-sdk-profile',
                       'dshVersion': version, 'pluginStamp': expected}
            (stage/'.matos-profile.json').write_text(json.dumps(receipt, indent=2)+'\n')
            os.rename(stage, target)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['home', 'template', 'plugin', 'sdk-plugin']:
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--profile', default='sdk')
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    try:
        print(prepare(args.home, args.template, args.profile, args.version, args.plugin, args.sdk_plugin))
    except (OSError, ValueError) as error:
        parser.exit(78, 'DSH profile upgrade: '+str(error)+'\n')


if __name__ == '__main__':
    main()
