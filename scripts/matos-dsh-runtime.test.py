"""Runtime-selection file contracts; fixtures never execute an agent or model."""
import argparse
import importlib.util
from pathlib import Path
import json
import shutil
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    obj=importlib.util.module_from_spec(spec);spec.loader.exec_module(obj);return obj
manager=module('runtime_selection',ROOT/'scripts/matos-dsh-runtime.py')
builder=module('runtime_builder',ROOT/'scripts/matos-dsh-prepare-runtime.py')


class Selection(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.base=self.root/'vendor/deepseek-harness';self.base.mkdir(parents=True)
        shutil.copy2(ROOT/'vendor/deepseek-harness/VERSION.json',self.base/'VERSION.json')
        for name in ['matos-plugin','matos-sdk-profile']:
            shutil.copytree(ROOT/'vendor/deepseek-harness'/name,self.base/name,ignore=shutil.ignore_patterns('node_modules'))
        (self.root/'scripts').mkdir()
        shutil.copy2(ROOT/'scripts/matos-dsh-prepare-runtime.py',self.root/'scripts/matos-dsh-prepare-runtime.py')
        self.old=self.bundle(self.base/'runtime')

    def bundle(self,path):
        version=manager.pinned_version(self.root)
        for name,installed in [('matos-plugin','dsh-assets'),('matos-sdk-profile','dsh-sdk-profile')]:
            for target in [path/'plugins'/name,path/'profiles/sdk/node_modules/@matos'/installed]:
                shutil.copytree(self.base/name,target)
        contents={name:'file-contract-only' for name in builder.CRITICAL_FILES}
        contents.update({'pnpm/package.json':'{}','pnpm/bin/pnpm.cjs':'file-contract-only',
            'runtime/node_modules/@deepseek-ai/dsh/package.json':json.dumps({'version':version}),
            'profiles/sdk/package.json':'{}','profiles/sdk/cordis.yml':'[]\n','profiles/sdk/cordis.patch.yml':'[]\n'})
        for name,value in contents.items():
            p=path/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value)
        metadata={'dshVersion':version,'nodeVersion':'file-contract-only','platform':builder.host_platform(),
                  'pluginHashes':builder.plugin_hashes(self.root),
                  'criticalHashes':{name:builder.digest(path/name) for name in contents}}
        (path/'manifest.json').write_text(json.dumps(metadata));return path

    def test_validated_switch_preserves_previous_release(self):
        new=self.bundle(self.base/'runtime-releases'/('a'*32))
        receipt=manager.activate(self.root,new,builder.verify)
        self.assertEqual(manager.selected(self.root),new)
        self.assertEqual(receipt['previousPath'],'runtime')
        self.assertTrue(builder.verify(self.old,self.root)['ok'])

    def test_switch_through_installation_alias_keeps_relative_rollback(self):
        alias=self.root/'alias'
        alias.symlink_to(self.root,target_is_directory=True)
        new=self.bundle(self.base/'runtime-releases'/('c'*32))
        receipt=manager.activate(alias,alias/new.relative_to(self.root),builder.verify)
        self.assertEqual(receipt['previousPath'],'runtime')
        self.assertEqual(receipt['path'],'runtime-releases/'+('c'*32))
        self.assertEqual(manager.selected(alias),new)

    def test_reselecting_current_release_preserves_rollback_reference(self):
        new=self.bundle(self.base/'runtime-releases'/('a'*32))
        manager.activate(self.root,new,builder.verify)
        before=(self.base/'runtime-active.json').read_bytes()
        manager.activate(self.root,new,builder.verify)
        self.assertEqual((self.base/'runtime-active.json').read_bytes(),before)
        self.assertEqual(json.loads(before)['previousPath'],'runtime')

    def test_corrupt_selected_release_restores_valid_previous_without_rebuilding(self):
        new=self.bundle(self.base/'runtime-releases'/('a'*32))
        manager.activate(self.root,new,builder.verify)
        (new/'manifest.json').unlink()
        args=argparse.Namespace(source=self.root,rebuild=False,check_host=False)
        receipt=manager.ensure(args)
        self.assertEqual(receipt['status'],'restored')
        self.assertEqual(manager.selected(self.root),self.old)
        self.assertTrue(new.is_dir())

    def test_bad_candidate_does_not_change_selection(self):
        good=self.bundle(self.base/'runtime-releases'/('a'*32));manager.activate(self.root,good,builder.verify)
        before=(self.base/'runtime-active.json').read_bytes()
        bad=self.bundle(self.base/'runtime-releases'/('b'*32))
        (bad/'profiles/sdk/node_modules/@matos/dsh-assets/index.js').write_text('// damaged\n')
        with self.assertRaises(ValueError):manager.activate(self.root,bad,builder.verify)
        self.assertEqual((self.base/'runtime-active.json').read_bytes(),before)
        self.assertEqual(manager.selected(self.root),good)

    def test_selection_cannot_escape_installation(self):
        (self.base/'runtime-active.json').write_text(json.dumps({'schemaVersion':1,'path':'../../other-user'}))
        with self.assertRaisesRegex(ValueError,'local versioned'):manager.selected(self.root)

    def test_release_symlink_cannot_escape_installation(self):
        outside=self.root/'outside';outside.mkdir()
        path=self.base/'runtime-releases'/('a'*32);path.parent.mkdir();path.symlink_to(outside,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'escapes'):manager.checked_path(self.root,str(path.relative_to(self.base)))


if __name__=='__main__':unittest.main()
