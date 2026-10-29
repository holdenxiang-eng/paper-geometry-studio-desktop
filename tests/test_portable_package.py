"""Package only the new application's public runtime, never user data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location('next_portable', Path(__file__).resolve().parents[1] / 'scripts/package-portable.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PortableRelease(unittest.TestCase):
    def fixture(self, root):
        for relative in package.REQUIRED_FILES:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'public-runtime')
        (root / 'native-manifest.json').write_text(json.dumps({'files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in package.NATIVE_FILES}, 'applicationFiles': []}))
        (root / 'resources/worker-lock.json').write_text(json.dumps({'files': []}))
        (root / 'resources/vision/assets-lock.json').write_text(json.dumps({'files': []}))
        (root / 'resources/desktop-runtime-lock.json').write_text(json.dumps({'files': [], 'licenses': []}))
        for relative in ['ui/vendor/fonts/KaTeX_Main-Regular.woff2', 'ui/vendor/LICENSE.katex', 'resources/licenses/vision/Qwen-LICENSE.txt',
                         'resources/python/Lib/site-packages/mathml2omml-0.0.2.dist-info/LICENSE',
                         'resources/python/Lib/site-packages/certifi/cacert.pem', 'resources/vision/llama/ggml-cpu-alderlake.dll',
                         'resources/python/Lib/site-packages/example/runtime_cache.py']:
            path = root / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'public-runtime')
        return root

    def test_archive_has_one_application_root_and_retains_models_fonts_and_licenses(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(Path(directory) / 'dist')
            result = package.build_package(root, Path(directory) / 'release.zip')
            with ZipFile(result['archive']) as archive:
                names = archive.namelist()
                self.assertTrue(all(name.startswith('截图组卷/') for name in names))
                self.assertEqual([name for name in names if name.count('/') == 1 and name.endswith('.exe')], ['截图组卷/截图组卷.exe'])
                self.assertIn('截图组卷/resources/python/Lib/site-packages/rapidocr/models/PP-OCRv6_rec_small.onnx', names)
                self.assertIn('截图组卷/resources/python/Lib/site-packages/mathml2omml-0.0.2.dist-info/LICENSE', names)
                self.assertIn('截图组卷/resources/python/Lib/site-packages/certifi/cacert.pem', names)
                self.assertIn('截图组卷/ui/vendor/fonts/KaTeX_Main-Regular.woff2', names)
                self.assertIn('截图组卷/resources/vision/llama/msvcp140.dll', names)
                self.assertIsNone(archive.testzip())
            self.assertEqual(hashlib.sha256(Path(result['archive']).read_bytes()).hexdigest(), result['sha256'])

    def test_private_files_caches_tests_and_unused_formula_experiment_do_not_ship(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(Path(directory) / 'dist')
            excluded = ['data/private.paper.json', 'data/screenshots/private.png', '.env', '.env.production',
                        'ui/.env', 'ui/capture.png', 'worker/__pycache__/service.pyc', 'worker/test_secret.py',
                        'resources/download-cache/api-key.txt', 'resources/models/formula/encoder.onnx',
                        'resources/python/Lib/site-packages/example/tests/test_private.py',
                        'resources/python/Lib/site-packages/example/__pycache__/private.pyc',
                        'resources/python/Lib/site-packages/example/.env', 'resources/python/private.key',
                        'resources/python/private.pem', 'resources/vision/llama/llama-quantize.exe',
                        'resources/vision/private.png', 'old-version/试卷工坊.exe']
            for relative in excluded:
                path = root / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'private must not ship')
            files = package.collect_files(root)
            names = {relative for relative, _ in files}
            for relative in excluded:
                self.assertNotIn(relative, names)
                self.assertTrue((root / relative).exists(), 'packaging must never delete the source file')
            self.assertIn('resources/python/Lib/site-packages/example/runtime_cache.py', names)

    def test_missing_or_changed_required_runtime_fails_before_publishing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(Path(directory) / 'dist')
            output = Path(directory) / 'release.zip'
            (root / 'worker/service.py').unlink()
            with self.assertRaisesRegex(ValueError, 'worker/service.py'):
                package.build_package(root, output)
            self.assertFalse(output.exists())
            (root / 'worker/service.py').write_bytes(b'public-runtime')
            (root / '截图组卷.exe').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                package.build_package(root, output)
            self.assertFalse(output.exists())

    def test_output_cannot_be_inside_an_included_runtime_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(Path(directory) / 'dist')
            with self.assertRaisesRegex(ValueError, 'output|输出'):
                package.build_package(root, root / 'resources/release.zip')

    def test_locked_model_hash_is_checked_while_writing_and_no_partial_release_survives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(Path(directory) / 'dist')
            name = 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'
            model = root / 'resources/vision' / name
            expected = hashlib.sha256(model.read_bytes()).hexdigest()
            (root / 'resources/vision/assets-lock.json').write_text(json.dumps({'files': [{'name': name, 'sha256': expected}]}))
            model.write_bytes(b'corrupted-model')
            output = Path(directory) / 'release.zip'
            with self.assertRaisesRegex(ValueError, '资源.*SHA256'):
                package.build_package(root, output)
            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix('.zip.partial').exists())

    def test_locked_crt_hash_is_checked_before_a_release_is_published(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(Path(directory) / 'dist')
            relative = 'python/msvcp140.dll'
            expected = hashlib.sha256((root / 'resources' / relative).read_bytes()).hexdigest()
            (root / 'resources/desktop-runtime-lock.json').write_text(json.dumps({'files': [{'file': relative, 'sha256': expected}], 'licenses': []}))
            (root / 'resources' / relative).write_bytes(b'corrupted-crt')
            output = Path(directory) / 'release.zip'
            with self.assertRaisesRegex(ValueError, '资源.*SHA256'):
                package.build_package(root, output)
            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix('.zip.partial').exists())


if __name__ == '__main__':
    unittest.main()
