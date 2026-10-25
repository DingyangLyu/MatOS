#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec=importlib.util.spec_from_file_location('dsh',Path(__file__).with_name('matos-rcbench-dsh.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class PublicProjection(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        task=self.root/'source';task.mkdir();(task/'data').mkdir();(task/'data/input.txt').write_text('PUBLIC')
        (task/'task_info.json').write_text(json.dumps({'task':'Compute from public data','data':[]}))
        (task/'hidden_answer.txt').write_text('HIDDEN')
        self.template=self.root/'instructions.py';self.template.write_text("INSTRUCTIONS_TEMPLATE = 'Task: {task_desc}\\nWorkspace: {workspace}\\n{data_text}'\n")
        self.ws=self.root/'attempt';self.task=task
    def tearDown(self): self.tmp.cleanup()
    def prepare(self): r.prepare(SimpleNamespace(task_root=self.task,instructions_template=self.template,workspace=self.ws))
    def test_snapshot_revision_uses_build_metadata(self):
        (self.root/'build-info.json').write_text(json.dumps({'commit':'release-source-sha','dirty':False}))
        self.assertEqual(r.source_revision(self.root),{'sourceCommit':'release-source-sha','sourceDirty':False})
    def test_snapshot_without_metadata_does_not_inherit_parent_git(self):
        self.assertEqual(r.source_revision(self.root),{'sourceCommit':'unknown','sourceDirty':None})
    def test_only_public_files_are_projected(self):
        self.prepare();self.assertEqual((self.ws/'data/input.txt').read_text(),'PUBLIC');self.assertFalse((self.ws/'hidden_answer.txt').exists())
        cmd=r.command(self.ws);self.assertEqual(cmd[-1],(self.ws/'INSTRUCTIONS.md').read_text());self.assertIn('deepseek-flash',cmd);self.assertNotIn('--max-turns',cmd)
    def test_existing_attempt_is_not_replaced(self):
        self.prepare();(self.ws/'_started.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'Existing attempt'):r.run(SimpleNamespace(workspace=self.ws,gpu='',timeout_seconds=1))
    def test_changed_inputs_are_rejected_before_launch(self):
        self.prepare();(self.ws/'data/input.txt').write_text('MODIFIED')
        with self.assertRaisesRegex(ValueError,'changed after preparation'):r.run(SimpleNamespace(workspace=self.ws,gpu='',timeout_seconds=1))
        self.assertFalse((self.ws/'_started.json').exists())
    def test_symlinks_cannot_project_hidden_inputs(self):
        (self.task/'data/input.txt').unlink();(self.task/'data/input.txt').symlink_to(self.task/'hidden_answer.txt')
        with self.assertRaisesRegex(ValueError,'symlink'):self.prepare()

if __name__=='__main__':unittest.main()
