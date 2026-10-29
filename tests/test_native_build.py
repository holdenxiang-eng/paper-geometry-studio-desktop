import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('native_builder', ROOT / 'scripts/build-native.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class NativeBuild(unittest.TestCase):
    def test_official_sdk_cache_matches_the_pinned_sha512(self):
        filename = ROOT / '.cache' / f'microsoft.web.webview2.{builder.SDK_VERSION}.nupkg'
        self.assertTrue(builder.sdk_valid(filename))
        with tempfile.TemporaryDirectory() as directory:
            bad = Path(directory) / 'bad.nupkg'
            bad.write_bytes(b'not-an-official-package')
            self.assertFalse(builder.sdk_valid(bad))

    def test_sync_copies_code_without_touching_independently_installed_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / 'source', root / 'dist'
            for folder in ['ui', 'worker', 'resources']:
                (source / folder).mkdir(parents=True)
            (source / 'ui/index.html').write_text('local-ui')
            (source / 'worker/service.py').write_text('local-worker')
            (source / 'resources/model.bin').write_bytes(b'source-model-not-copied')
            (source / 'worker/.env').write_text('private-fixture')
            (output / 'resources').mkdir(parents=True)
            (output / 'resources/model.bin').write_bytes(b'already-installed-model')
            copied = builder.copy_application(output, source)
            self.assertEqual(sorted(copied), ['ui/index.html', 'worker/service.py'])
            self.assertEqual((output / 'resources/model.bin').read_bytes(), b'already-installed-model')
            self.assertFalse((output / 'worker/.env').exists())
            with self.assertRaisesRegex(RuntimeError, 'boundary'):
                builder.copy_application(source / 'ui/recursive-output', source)


if __name__ == '__main__':
    unittest.main()
