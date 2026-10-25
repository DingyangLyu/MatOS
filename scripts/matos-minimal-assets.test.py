"""File-policy tests for the export boundary; no agent/model fixtures."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location("minimal_export",Path(__file__).with_name("matos-minimal-assets.py"))
exporter=importlib.util.module_from_spec(spec);spec.loader.exec_module(exporter)

class ExportBoundary(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);exporter.ROOT=self.root
        self.base=self.root/"distribution/benchmark-minimal";self.assets=self.base/"assets"
        self.assets.mkdir(parents=True)
        self.file=self.assets/"packs/public/ROLE.md";self.file.parent.mkdir(parents=True);self.file.write_text("Reviewed public text\n")
        self.record={"path":"packs/public/ROLE.md","bytes":self.file.stat().st_size,"sha256":hashlib.sha256(self.file.read_bytes()).hexdigest()}
        self.manifest={"assetCount":1,"files":[self.record]}
        self.write_manifest()
        self.out=self.root/"out"
    def write_manifest(self):
        (self.base/"manifest.json").write_text(json.dumps(self.manifest))
    def test_only_allowlisted_files_leave_source(self):
        (self.assets/"private-research.md").write_text("Must stay internal")
        exporter.export(self.out)
        self.assertEqual(sorted(str(p.relative_to(self.out)) for p in self.out.rglob("*") if p.is_file()),
                         ["EXPORT.json","README.md","matos-assets/packs/public/ROLE.md"])
    def test_changed_content_requires_review(self):
        self.file.write_text("Unreviewed content")
        with self.assertRaisesRegex(ValueError,"Review"):exporter.export(self.out)
        self.assertFalse(self.out.exists())
    def test_traversal_is_rejected(self):
        self.record["path"]="../../private.env";self.write_manifest()
        with self.assertRaises(ValueError):exporter.export(self.out)
    def test_external_symlink_is_rejected(self):
        outside=self.root/"private.txt";outside.write_bytes(self.file.read_bytes())
        self.file.unlink();self.file.symlink_to(outside)
        with self.assertRaises(ValueError):exporter.export(self.out)
    def test_existing_output_is_preserved(self):
        self.out.mkdir();(self.out/"keep").write_text("Existing")
        with self.assertRaises(ValueError):exporter.export(self.out)
        self.assertEqual((self.out/"keep").read_text(),"Existing")
    def test_duplicate_manifest_path_is_rejected(self):
        self.manifest["files"].append(self.record.copy());self.write_manifest()
        with self.assertRaises(ValueError):exporter.export(self.out)

class ModelCatalogPaths(unittest.TestCase):
    def test_model_catalog_preserves_explicit_paths_and_checksums(self):
        source=Path(__file__).resolve().parents[1]/'distribution/benchmark-minimal/benchmark-assets/packs/matos-core/tools/mlip-model-catalog/tool.py'
        spec=importlib.util.spec_from_file_location('portable_catalog',source)
        catalog=importlib.util.module_from_spec(spec);spec.loader.exec_module(catalog)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);model=root/'mace/model.bin';model.parent.mkdir();model.write_bytes(b'checksum fixture')
            manifest_path=root/'asset.json'
            for path in [str(model),'mace/model.bin']:
                manifest={'type':'data','id':'probe','version':'1','metadata':{'family':'mace','files':[{'path':path,'sha256':hashlib.sha256(model.read_bytes()).hexdigest()}]}}
                report=catalog.serialize_model_asset(manifest_path,manifest,True)
                expected=model.resolve() if path.startswith('/') else (root/'mace/model.bin').resolve()
                self.assertEqual(report['files'][0]['path'],str(expected))
                self.assertTrue(report['files'][0]['checksumOk'])
                self.assertTrue(report['files'][0]['exists'])


class RestoredProfiles(unittest.TestCase):
    """Pin the usage-based benchmark profiles and their runtime-only roles."""
    root=Path(__file__).resolve().parents[1]/'distribution/benchmark-minimal'
    expected={
        'benchmark':{'assets':28,'types':{'skill':5,'knowledge':1,'data':2,'tool':18,'role':2},'hidden':False},
        'workspace':{'assets':37,'types':{'skill':7,'knowledge':2,'data':2,'tool':18,'role':7,'workflow':1},'hidden':True},
    }
    def load(self,profile):
        name='manifest-benchmark.json' if profile=='benchmark' else 'manifest.json'
        return json.loads((self.root/name).read_text())
    def test_counts_and_required_roles(self):
        for profile,want in self.expected.items():
            manifest=self.load(profile)
            self.assertEqual(manifest['assetCount'],want['assets'])
            self.assertEqual(len(manifest['assets']),want['assets'])
            self.assertEqual(len({x['ref'] for x in manifest['assets']}),want['assets'])
            refs={x['ref'].split('@')[0] for x in manifest['assets']}
            for role in ('role:compute','role:research-scientist'):
                self.assertIn(role,refs)
            hidden={'role:user-feedback-critic','role:direct-asset-editor','role:self-evolution-worker','role:turn-feedback-classifier','role:semantic-acceptance-judge'}
            self.assertEqual(hidden.issubset(refs),want['hidden'])
            for ref in manifest['assets']:
                self.assertIn(ref['mode'],('restored','sanitized','workspace-only'))
                self.assertTrue(ref['reason'])
    def test_type_counts(self):
        for profile,want in self.expected.items():
            counts={}
            for ref in self.load(profile)['assets']:
                kind=ref['ref'].split(':')[0]
                counts[kind]=counts.get(kind,0)+1
            self.assertEqual(counts,want['types'])
    def test_no_weights_or_large_example_outputs(self):
        for profile in self.expected:
            for record in self.load(profile)['files']:
                suffix=Path(record['path']).suffix.lower()
                self.assertNotIn(suffix,{'.pt','.pth','.ckpt','.model','.traj'})
                self.assertFalse(Path(record['path']).name.lower().startswith(('chgcar','locpot','wavecar')))
                self.assertLessEqual(record['bytes'],1024*1024)

if __name__=="__main__":unittest.main()
