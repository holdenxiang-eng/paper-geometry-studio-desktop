import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('release_assets', ROOT / 'scripts/package-release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
REPOSITORY = 'holdenxiang-eng/paper-geometry-studio-desktop'


class ReleaseAssets(unittest.TestCase):
    def test_parts_reassemble_exact_bytes_and_lock_each_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / 'app.zip', root / 'assets'
            content = bytes(range(256)) * 10 + b'end'
            source.write_bytes(content)
            path, manifest = release.prepare_assets(source, output, REPOSITORY, 'v0.1.1', 1000)
            self.assertEqual(json.loads(path.read_text('utf-8')), manifest)
            actual = b''.join((output / p['fileName']).read_bytes() for p in manifest['parts'])
            self.assertEqual(actual, content)
            self.assertEqual([p['bytes'] for p in manifest['parts']], [1000, 1000, 563])
            self.assertEqual(manifest['package']['sha256'], hashlib.sha256(content).hexdigest())
            for part in manifest['parts']:
                self.assertEqual(part['sha256'], hashlib.sha256((output / part['fileName']).read_bytes()).hexdigest())
                self.assertTrue(part['url'].startswith('https://github.com/' + REPOSITORY + '/releases/download/v0.1.1/'))

    def test_bad_receipt_never_creates_install_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'app.zip'
            source.write_bytes(b'wrong')
            source.with_suffix('.zip.sha256').write_text('0' * 64 + '  app.zip\n')
            with self.assertRaisesRegex(ValueError, '校验'):
                release.prepare_assets(source, root / 'assets', REPOSITORY, 'v0.1.1', 3)
            self.assertFalse((root / 'assets/release-manifest.json').exists())

    def test_reject_invalid_destination_version_and_oversized_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'app.zip'
            source.write_bytes(b'payload')
            for repository, tag, size in [('other/repository', 'v0.1.1', 10),
                                           (REPOSITORY, '../v1', 10),
                                           (REPOSITORY, 'v0.1.1', release.ASSET_LIMIT),
                                           (REPOSITORY, 'v0.1.1', 0)]:
                with self.assertRaises(ValueError):
                    release.prepare_assets(source, Path(directory) / 'assets', repository, tag, size)


if __name__ == '__main__':
    unittest.main()
