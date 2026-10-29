"""Offline acceptance for independent, pinned recognition-resource preparation."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('setup_worker', Path(__file__).resolve().parents[1] / 'scripts/setup-worker.py')
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'independent-application'
        self.resources = self.root / 'dist/resources'
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as target:
            target.writestr('llama-server.exe', b'fake-server')
            target.writestr('ggml-cpu.dll', b'fake-library')
        names = list(setup.VISION_ASSETS)
        self.payloads = {names[0]: archive.getvalue(), names[1]: b'fake-model', names[2]: b'fake-projector'}
        self.licenses = {name: b'license-' + name.encode() for name in setup.VISION_LICENSES}
        self.pins = {name: hashlib.sha256(value).hexdigest() for name, value in self.payloads.items()}
        license_pins = {name: {**record, 'sha256': hashlib.sha256(self.licenses[name]).hexdigest()}
                        for name, record in setup.VISION_LICENSES.items()}
        self.calls = []
        def download(url, filename, expected):
            name = filename.name
            data = self.payloads[name] if name in self.payloads else self.licenses[name]
            self.assertEqual(hashlib.sha256(data).hexdigest(), expected)
            self.calls.append(url)
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_bytes(data)
            return {'file': filename.relative_to(self.resources).as_posix(), 'url': url, 'sha256': expected, 'bytes': len(data)}
        for name, value in [('ROOT', self.root), ('RESOURCES', self.resources), ('VISION_ASSETS', self.pins), ('VISION_LICENSES', license_pins), ('download', download)]:
            context = patch.object(setup, name, value)
            context.start()
            self.addCleanup(context.stop)

    def test_empty_independent_application_uses_only_pinned_official_sources(self):
        setup.prepare_vision()
        self.assertEqual(set(self.calls), set(setup.VISION_URLS.values()) | {value['url'] for value in setup.VISION_LICENSES.values()})
        for name in list(self.payloads)[1:]:
            self.assertEqual((self.resources / 'vision' / name).read_bytes(), self.payloads[name])
        self.assertTrue((self.resources / 'vision/llama/llama-server.exe').is_file())
        manifest = json.loads((self.resources / 'vision/assets-lock.json').read_text('utf-8'))
        self.assertEqual(len(manifest['files']), 3)
        self.assertEqual(len(manifest['licenses']), 2)
        self.assertFalse(self.root.parent.joinpath('desktop').exists())

    def test_explicit_asset_reuse_verifies_and_hardlinks_model_files(self):
        source = Path(self.temp.name) / 'explicit-public-assets'
        source.mkdir()
        for name, data in self.payloads.items():
            (source / name).write_bytes(data)
        setup.prepare_vision(source)
        self.assertEqual(set(self.calls), {value['url'] for value in setup.VISION_LICENSES.values()})
        for name in list(self.payloads)[1:]:
            self.assertTrue((source / name).samefile(self.resources / 'vision' / name))

    def test_an_existing_different_model_is_preserved_and_rejected(self):
        target = self.resources / 'vision' / list(self.payloads)[1]
        target.parent.mkdir(parents=True)
        target.write_bytes(b'preserve-existing-file')
        with self.assertRaisesRegex(RuntimeError, 'Do not overwrite'):
            setup.prepare_vision()
        self.assertEqual(target.read_bytes(), b'preserve-existing-file')


if __name__ == '__main__':
    unittest.main()
