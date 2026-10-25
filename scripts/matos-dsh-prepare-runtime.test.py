"""File-contract tests; these fixtures never execute or emulate a runtime."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_dsh', SOURCE/'scripts/matos-dsh-prepare-runtime.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class DistributionVerification(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bundle = Path(self.temp.name)
        version = json.loads((SOURCE/'vendor/deepseek-harness/VERSION.json').read_text())['version'].removeprefix('dsh-v')
        for name, installed in [('matos-plugin', 'dsh-assets'), ('matos-sdk-profile', 'dsh-sdk-profile')]:
            for target in [self.bundle/'plugins'/name, self.bundle/'profiles/sdk/node_modules/@matos'/installed]:
                shutil.copytree(SOURCE/'vendor/deepseek-harness'/name, target, ignore=shutil.ignore_patterns('node_modules'))
        files = {
            'bin/dsh': 'file-contract-only', 'bin/rg': 'file-contract-only',
            'node/bin/node': 'file-contract-only', 'pnpm/bin/pnpm.cjs': 'file-contract-only',
            'pnpm/package.json': '{}',
            'runtime/node_modules/@deepseek-ai/dsh/package.json': json.dumps({'version': version}),
            'profiles/sdk/package.json': '{}', 'profiles/sdk/.matos-plugin-installed': 'file-contract-only',
            'profiles/sdk/cordis.yml': '# default root\n[]\n', 'profiles/sdk/cordis.patch.yml': '[]\n',
        }
        for name, content in files.items():
            p = self.bundle/name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        self.meta = {'dshVersion': version, 'nodeVersion': 'file-contract-only', 'platform': builder.host_platform(),
                     'pluginHashes': builder.plugin_hashes(SOURCE),
                     'criticalHashes': {name: builder.digest(self.bundle/name) for name in files}}
        self.write_manifest()

    def write_manifest(self):
        (self.bundle/'manifest.json').write_text(json.dumps(self.meta))

    def test_wrong_host_platform_is_rejected(self):
        self.meta['platform'] = 'unsupported-test-cpu'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'platform mismatch'):
            builder.verify(self.bundle, SOURCE)

    def test_matching_file_contract(self):
        self.assertTrue(builder.verify(self.bundle, SOURCE)['ok'])

    def test_changed_installed_asset_store_is_rejected(self):
        (self.bundle/'profiles/sdk/node_modules/@matos/dsh-assets/assetStore.js').write_text('// stale copy\n')
        with self.assertRaisesRegex(ValueError, 'assetStore'):
            builder.verify(self.bundle, SOURCE)

    def test_changed_bootstrap_plugin_is_rejected(self):
        (self.bundle/'plugins/matos-plugin/assetStore.js').write_text('// stale copy\n')
        with self.assertRaisesRegex(ValueError, 'assetStore'):
            builder.verify(self.bundle, SOURCE)

    def test_missing_checksums_are_rejected(self):
        self.meta['criticalHashes'] = {}
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'checksum'):
            builder.verify(self.bundle, SOURCE)

    def test_custom_profile_root_is_rejected_even_with_updated_checksum(self):
        path = self.bundle/'profiles/sdk/cordis.yml'
        path.write_text('- name: custom-provider\n  config:\n    apiKey: synthetic-only\n')
        self.meta['criticalHashes']['profiles/sdk/cordis.yml'] = builder.digest(path)
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'clean SDK'):
            builder.verify(self.bundle, SOURCE)


if __name__ == '__main__':
    unittest.main()
