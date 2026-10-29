"""App-local CRT preparation uses bounded, pinned publisher files."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('desktop_runtime', ROOT / 'scripts/prepare-desktop-runtime.py')
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class DesktopRuntimeTests(unittest.TestCase):
    def fixture(self, root):
        source = root / 'VS/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT'
        source.mkdir(parents=True)
        content = b'MZ-test-publisher-crt'
        (source / 'msvcp140.dll').write_bytes(content)
        records = {'msvcp140.dll': (len(content), hashlib.sha256(content).hexdigest())}
        dist = root / 'app'
        for relative in runtime.PREREQUISITES:
            target = dist / 'resources' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'fixture')
        cache = root / 'license-cache'
        cache.mkdir()
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Publisher license fixture</w:t></w:r></w:p></w:body></w:document>')
        content = raw.getvalue()
        license = cache / 'License.txt'
        license.write_text('Publisher license fixture\n', encoding='utf-8')
        licenses = {license.name: ('https://visualstudio.microsoft.com/fixture.docx', len(content), hashlib.sha256(content).hexdigest(),
                                  license.stat().st_size, runtime.digest(license))}
        return source, dist, cache, records, licenses

    def test_all_runtime_search_locations_receive_exact_files_and_license(self):
        with tempfile.TemporaryDirectory() as directory:
            source, dist, cache, files, licenses = self.fixture(Path(directory))
            with patch.object(runtime, 'CRT_FILES', files), patch.object(runtime, 'LICENSES', licenses):
                result = runtime.prepare(dist, source, license_cache=cache)
            self.assertFalse(result['systemInstallation'])
            manifest = json.loads((dist / 'resources/desktop-runtime-lock.json').read_text('utf-8'))
            self.assertEqual(len(manifest['files']), 3)
            for location in runtime.TARGETS:
                self.assertEqual((dist / 'resources' / location / 'msvcp140.dll').read_bytes(), (source / 'msvcp140.dll').read_bytes())
            self.assertEqual((dist / 'resources/licenses/msvc/License.txt').read_bytes(), (cache / 'License.txt').read_bytes())
            self.assertFalse(any(path.name.endswith(('.docx', '.bin')) for path in (dist / 'resources/licenses/msvc').iterdir()))

    def test_changed_publisher_file_is_rejected_before_changing_existing_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            source, dist, cache, files, licenses = self.fixture(Path(directory))
            target = dist / 'resources/python/msvcp140.dll'
            target.write_bytes(b'old-app-runtime')
            (source / 'msvcp140.dll').write_bytes(b'tampered')
            with patch.object(runtime, 'CRT_FILES', files), patch.object(runtime, 'LICENSES', licenses):
                with self.assertRaisesRegex(ValueError, 'CRT'):
                    runtime.prepare(dist, source, license_cache=cache)
            self.assertEqual(target.read_bytes(), b'old-app-runtime')

    def test_system_or_debug_runtime_sources_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for location in ['System32', 'VS/debug_nonredist/x64/Microsoft.VC143.CRT']:
                source = root / location
                source.mkdir(parents=True)
                with self.assertRaisesRegex(ValueError, '发布目录'):
                    runtime.validate_source(source)

    def test_target_cannot_escape_the_application_root(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, '越界'):
                runtime.local_target(Path(directory), '../system-destination.dll')

    def test_official_docx_is_verified_in_memory_and_only_complete_text_is_saved(self):
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>First term.</w:t></w:r></w:p><w:p><w:r><w:t>Last term.</w:t></w:r></w:p></w:body></w:document>')
        content = raw.getvalue()
        text = b'First term.\nLast term.\n'
        url = 'https://visualstudio.microsoft.com/license.docx'
        class Response(io.BytesIO):
            def geturl(self): return url
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            with patch.object(runtime.urllib.request, 'urlopen', return_value=Response(content)):
                result = runtime.license_file(cache, 'License.txt', url, len(content), hashlib.sha256(content).hexdigest(),
                                              len(text), hashlib.sha256(text).hexdigest())
            self.assertEqual(result.read_bytes(), text)
            self.assertEqual([path.name for path in cache.iterdir()], ['License.txt'])


if __name__ == '__main__':
    unittest.main()
