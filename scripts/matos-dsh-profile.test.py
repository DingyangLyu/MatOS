"""Real filesystem/profile publication checks; no model or runtime is emulated."""
import importlib.util
from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT=Path(__file__).with_name('matos-dsh-profile.py')
spec=importlib.util.spec_from_file_location('profile_upgrade',SCRIPT)
profile=importlib.util.module_from_spec(spec);spec.loader.exec_module(profile)


class ProfileUpgrade(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.home=self.root/'home';self.template=self.root/'template'
        self.plugin=self.root/'source/matos-plugin';self.sdk=self.root/'source/matos-sdk-profile'
        for p in [self.plugin,self.sdk]:
            p.mkdir(parents=True);(p/'package.json').write_text(json.dumps({'name':p.name,'dependencies':{}}))
            (p/'index.js').write_text('// filesystem contract revision A\n');(p/'cordis.patch.yml').write_text('[]\n')
        self.refresh_template()
        self.home.mkdir();(self.home/'sessions').mkdir();(self.home/'sessions/keep').write_text('existing history')

    def refresh_template(self):
        target=self.template/'sdk';target.mkdir(parents=True,exist_ok=True)
        for name in ['cordis.yml','cordis.patch.yml']:(target/name).write_text('[]\n')
        for src,package in [(self.plugin,'dsh-assets'),(self.sdk,'dsh-sdk-profile')]:
            dst=target/'node_modules/@matos'/package
            if dst.exists():shutil.rmtree(dst)
            shutil.copytree(src,dst)
        (target/'.matos-plugin-installed').write_text(profile.plugin_stamp('0.2.1-alpha.2',self.plugin,self.sdk)+'\n')

    def prepare(self):
        return profile.prepare(self.home,self.template,'sdk','0.2.1-alpha.2',self.plugin,self.sdk)

    def test_new_release_keeps_old_profile_and_history(self):
        first=self.prepare();old=self.home/'profiles'/first/'node_modules/@matos/dsh-assets/index.js'
        original=old.read_bytes()
        (self.plugin/'index.js').write_text('// filesystem contract revision B\n');self.refresh_template()
        second=self.prepare()
        self.assertNotEqual(first,second);self.assertEqual(old.read_bytes(),original)
        self.assertEqual((self.home/'sessions/keep').read_text(),'existing history')
        self.assertEqual(self.prepare(),second)

    def test_stale_template_does_not_replace_working_profile(self):
        first=self.prepare();(self.plugin/'index.js').write_text('// changed source\n')
        with self.assertRaisesRegex(ValueError,'different MatOS'):
            self.prepare()
        self.assertTrue((self.home/'profiles'/first).is_dir())
        self.assertEqual(len(list((self.home/'profiles').glob('sdk-matos-*'))),1)

    def test_custom_legacy_configuration_is_preserved(self):
        old=self.home/'profiles/sdk';old.mkdir(parents=True)
        (old/'cordis.yml').write_text('- name: custom-provider\n')
        with self.assertRaisesRegex(ValueError,'custom configuration'):
            self.prepare()
        self.assertEqual((old/'cordis.yml').read_text(),'- name: custom-provider\n')

    def test_legacy_stale_install_is_not_overwritten(self):
        old=self.home/'profiles/sdk';old.mkdir(parents=True)
        (old/'cordis.yml').write_text('[]\n');(old/'cordis.patch.yml').write_text('[]\n')
        (old/'.matos-plugin-installed').write_text('old revision')
        selected=self.prepare()
        self.assertTrue((self.home/'profiles'/selected).is_dir())
        self.assertEqual((old/'.matos-plugin-installed').read_text(),'old revision')

    def test_corrupted_installed_plugin_is_rejected(self):
        name=self.prepare();p=self.home/'profiles'/name/'node_modules/@matos/dsh-assets/index.js'
        p.write_text('// changed outside installer\n')
        with self.assertRaisesRegex(ValueError,'content does not match'):
            self.prepare()

    def test_concurrent_initializers_publish_one_complete_profile(self):
        args=[sys.executable,str(SCRIPT),'--home',str(self.home),'--template',str(self.template),
              '--plugin',str(self.plugin),'--sdk-plugin',str(self.sdk),'--version','0.2.1-alpha.2']
        children=[subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
        outputs=[child.communicate(timeout=10) for child in children]
        self.assertEqual([p.returncode for p in children],[0,0],outputs)
        self.assertEqual(outputs[0][0],outputs[1][0])
        self.assertEqual(len(list((self.home/'profiles').glob('sdk-matos-*'))),1)


if __name__=='__main__':unittest.main()
