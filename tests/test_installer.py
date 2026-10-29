"""Exercise the first-install entry with local tiny ZIP parts and no model."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('installer_builder', ROOT / 'scripts/build-installer.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
REPOSITORY = 'holdenxiang-eng/paper-geometry-studio-desktop'
PREFIX = 'https://github.com/' + REPOSITORY + '/releases/download/v-test/'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def package(extra=None, revision=b'first-version'):
    files = {name: b'fixture-file' for name in [
        'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll',
        'ui/index.html', 'worker/service.py', 'resources/python/python.exe', 'resources/python/python312.dll',
        'resources/vision/llama/llama-server.exe', 'resources/vision/Qwen3VL-4B-Instruct-Q4_K_M.gguf',
        'resources/vision/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
        'resources/python/Lib/site-packages/rapidocr/models/PP-OCRv6_det_small.onnx',
        'resources/python/Lib/site-packages/rapidocr/models/PP-OCRv6_rec_small.onnx',
        'resources/python/Lib/site-packages/rapidocr/models/ch_ppocr_mobile_v2.0_cls_mobile.onnx']}
    files['截图组卷.exe'] = b'MZ-' + revision
    files['native-manifest.json'] = json.dumps({'launcher': '截图组卷.exe', 'files': {'截图组卷.exe': digest(files['截图组卷.exe'])}}).encode()
    output = io.BytesIO()
    with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr('截图组卷/' + name, data)
        if extra:
            for name, data in extra.items():
                archive.writestr(name, data)
    return output.getvalue()


@unittest.skipUnless(os.name == 'nt', 'Windows installer tests')
class Installer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cache = ROOT / '.cache/installer-tests'
        cls.cache.mkdir(parents=True, exist_ok=True)
        cls.root = Path(tempfile.mkdtemp(prefix='entry-', dir=cls.cache))
        cls.manifest, cls.parts = cls.make_parts(cls.root, package())
        cls.exe = cls.root / 'Installer.exe'
        builder.build(cls.manifest, cls.exe, REPOSITORY)
        # The production parser keeps its GitHub-only policy. This test-owned
        # reflection probe exercises the private HTTP transport on loopback.
        probe_source = cls.root / 'DownloadProbe.cs'
        probe_source.write_text(r'''using System;using System.IO;using System.Linq.Expressions;using System.Reflection;using System.Threading;using System.Web.Script.Serialization;
class Probe {static int Main(string[] args){Console.OutputEncoding=new System.Text.UTF8Encoding(false);try{var assembly=Assembly.LoadFrom(args[0]);if(args[1]=="--normalize"){var path=assembly.GetType("ScreenshotInstaller.InstallCore").GetMethod("Full",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{args[2]});Console.WriteLine(new JavaScriptSerializer().Serialize(new{path=path}));return 0;}var partType=assembly.GetType("ScreenshotInstaller.Part");var part=Activator.CreateInstance(partType,true);var flags=BindingFlags.Instance|BindingFlags.NonPublic;
partType.GetField("Name",flags).SetValue(part,"fixture.bin");partType.GetField("Bytes",flags).SetValue(part,Int64.Parse(args[3]));partType.GetField("Hash",flags).SetValue(part,args[4]);partType.GetField("Url",flags).SetValue(part,new Uri(args[1]));
var progress=assembly.GetType("ScreenshotInstaller.InstallProgress");var callback=Expression.Lambda(typeof(Action<>).MakeGenericType(progress),Expression.Empty(),Expression.Parameter(progress,"value")).Compile();
using(var cancel=new CancellationTokenSource()){int delay=Int32.Parse(args[5]);if(delay>0)cancel.CancelAfter(delay);assembly.GetType("ScreenshotInstaller.InstallCore").GetMethod("Download",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{part,args[2],0L,Int64.Parse(args[3]),cancel.Token,callback});}
Console.WriteLine("{\"passed\":true}");return 0;}catch(Exception error){while(error is TargetInvocationException&&error.InnerException!=null)error=error.InnerException;Console.WriteLine(new JavaScriptSerializer().Serialize(new{passed=false,cancelled=error is OperationCanceledException,error=error.Message}));return 1;}}}''', encoding='utf-8-sig')
        cls.probe = cls.root / 'DownloadProbe.exe'
        csc = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        subprocess.run([str(csc), '/nologo', '/target:exe', '/platform:x64', '/reference:System.Core.dll',
                        '/reference:System.Web.Extensions.dll', '/out:' + str(cls.probe), str(probe_source)],
                       check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        assert cls.root.resolve().is_relative_to(cls.cache.resolve())
        shutil.rmtree(cls.root)

    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix='case-', dir=self.root))

    @staticmethod
    def make_parts(folder, data):
        folder.mkdir(parents=True, exist_ok=True)
        # This split bisects a ZIP header. It is not dependent on entry boundaries.
        chunks = [data[:101], data[101:]]
        names = ['payload-01.bin', 'payload-02.bin']
        for name, chunk in zip(names, chunks):
            (folder / name).write_bytes(chunk)
        document = {'schema': 1, 'product': 'paper-geometry-studio', 'supportedWindows64': True,
                    'package': {'fileName': 'portable.zip', 'bytes': len(data), 'sha256': digest(data)},
                    'parts': [{'fileName': name, 'bytes': len(chunk), 'sha256': digest(chunk), 'url': PREFIX + name}
                              for name, chunk in zip(names, chunks)]}
        manifest = folder / 'manifest.json'
        manifest.write_text(json.dumps(document), encoding='utf-8')
        return manifest, folder

    def invoke(self, manifest=None, parts=None, target=None, flags=()):
        result = self.folder / 'result.json'
        args = [str(self.exe), '--self-test', '--manifest', str(manifest or self.manifest),
                '--parts', str(parts or self.parts), '--target', str(target or self.folder / 'app'),
                '--result', str(result), *flags]
        completed = subprocess.run(args, capture_output=True, timeout=20, creationflags=0x08000000)
        return completed.returncode, json.loads(result.read_text('utf-8-sig'))

    def download(self, data, *, partial=b'', mode='range', cancel_ms=0, expected_hash=None):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                header = self.headers.get('Range')
                requests.append(header)
                if mode == 'foreign-redirect':
                    self.send_response(302)
                    self.send_header('Location', 'https://example.invalid/untrusted')
                    self.end_headers()
                    return
                start = int(header.split('=')[1].split('-')[0]) if header and mode != 'ignore-range' else 0
                self.send_response(206 if start else 200)
                if start:
                    self.send_header('Content-Range', f'bytes {start}-{len(data)-1}/{len(data)}')
                self.send_header('Content-Length', str(len(data)-start))
                self.end_headers()
                try:
                    for offset in range(start, len(data), 256):
                        self.wfile.write(data[offset:offset+256])
                        self.wfile.flush()
                        if mode == 'slow': time.sleep(.03)
                except OSError:
                    pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        destination = self.folder / 'download.bin'
        if partial:
            destination.with_suffix('.bin.download').write_bytes(partial)
        try:
            completed = subprocess.run([str(self.probe), str(self.exe), f'http://127.0.0.1:{server.server_port}/part',
                                        str(destination), str(len(data)), expected_hash or digest(data), str(cancel_ms)],
                                       capture_output=True, text=True, encoding='utf-8', timeout=10, creationflags=0x08000000)
            result = json.loads(completed.stdout)
            return completed.returncode, result, destination, requests
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_local_parts_install_without_python_or_network(self):
        code, result = self.invoke()
        self.assertEqual(code, 0, result)
        target = Path(result['target'])
        self.assertEqual((target / '截图组卷.exe').read_bytes(), b'MZ-first-version')
        self.assertFalse(target.with_name(target.name + '.install-cache').exists())
        self.assertFalse(list(self.folder.glob('.*.install-stage-*')))

    def test_drive_root_is_preserved_for_owned_cleanup_boundaries(self):
        completed = subprocess.run([str(self.probe), str(self.exe), '--normalize', 'D:\\'],
                                   capture_output=True, text=True, encoding='utf-8', timeout=10, creationflags=0x08000000)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(json.loads(completed.stdout)['path'], 'D:\\')

    def test_bad_part_hash_leaves_the_target_absent(self):
        manifest, parts = self.make_parts(self.folder / 'parts', package())
        (parts / 'payload-02.bin').write_bytes(b'damaged')
        code, result = self.invoke(manifest, parts)
        self.assertEqual(code, 1)
        self.assertIn('校验', result['error'])
        self.assertFalse((self.folder / 'app').exists())

    def test_bad_complete_package_hash_is_not_installed(self):
        manifest, parts = self.make_parts(self.folder / 'parts', package())
        value = json.loads(manifest.read_text('utf-8'))
        value['package']['sha256'] = '0' * 64
        manifest.write_text(json.dumps(value), encoding='utf-8')
        code, result = self.invoke(manifest, parts)
        self.assertEqual(code, 1)
        self.assertIn('完整安装包校验失败', result['error'])
        self.assertFalse((self.folder / 'app').exists())

    def test_zip_traversal_is_refused_before_install(self):
        manifest, parts = self.make_parts(self.folder / 'parts', package({'截图组卷/../outside.txt': b'no'}))
        code, result = self.invoke(manifest, parts)
        self.assertEqual(code, 1, result)
        self.assertFalse((self.folder / 'outside.txt').exists())
        self.assertFalse((self.folder / 'app').exists())

    def test_payload_cannot_contain_user_data(self):
        manifest, parts = self.make_parts(self.folder / 'parts', package({'截图组卷/data/project.paper.json': b'no'}))
        code, result = self.invoke(manifest, parts)
        self.assertEqual(code, 1, result)
        self.assertIn('用户数据', result['error'])

    def test_reinstall_and_upgrade_preserve_data_and_saved_projects(self):
        target = self.folder / 'app'
        self.assertEqual(self.invoke(target=target)[0], 0)
        (target / 'data').mkdir()
        (target / 'data/state.json').write_bytes(b'private-state')
        (target / 'my.paper.json').write_bytes(b'private-project')
        self.assertEqual(self.invoke(target=target)[0], 0)
        manifest, parts = self.make_parts(self.folder / 'new-parts', package(revision=b'next-version'))
        self.assertEqual(self.invoke(manifest, parts, target)[0], 0)
        self.assertEqual((target / 'data/state.json').read_bytes(), b'private-state')
        self.assertEqual((target / 'my.paper.json').read_bytes(), b'private-project')
        self.assertEqual((target / '截图组卷.exe').read_bytes(), b'MZ-next-version')

    def test_failed_upgrade_retains_the_original_install(self):
        target = self.folder / 'app'
        self.assertEqual(self.invoke(target=target)[0], 0)
        (target / 'data').mkdir()
        (target / 'data/state.json').write_bytes(b'keep')
        manifest, parts = self.make_parts(self.folder / 'bad-parts', package({'截图组卷/../escape': b'bad'}, revision=b'bad'))
        self.assertEqual(self.invoke(manifest, parts, target)[0], 1)
        self.assertEqual((target / '截图组卷.exe').read_bytes(), b'MZ-first-version')
        self.assertEqual((target / 'data/state.json').read_bytes(), b'keep')

    def test_cancel_before_work_preserves_existing_files(self):
        target = self.folder / 'app'
        self.assertEqual(self.invoke(target=target)[0], 0)
        code, result = self.invoke(target=target, flags=['--cancel-before'])
        self.assertEqual(code, 1)
        self.assertTrue(result['cancelled'])
        self.assertEqual((target / '截图组卷.exe').read_bytes(), b'MZ-first-version')

    def test_cancel_after_parts_keeps_verified_cache_for_retry(self):
        target = self.folder / 'app'
        code, result = self.invoke(target=target, flags=['--cancel-on-extract'])
        self.assertEqual(code, 1)
        self.assertTrue(result['cancelled'])
        self.assertFalse(target.exists())
        cache = target.with_name(target.name + '.install-cache')
        self.assertEqual(len(list(cache.glob('payload-*.bin'))), 2)
        self.assertFalse(list(self.folder.glob('.*.install-stage-*')))
        unavailable = self.folder / 'unavailable-originals'
        unavailable.mkdir()
        self.assertEqual(self.invoke(parts=unavailable, target=target)[0], 0)

    def test_unrelated_existing_files_are_never_overwritten(self):
        target = self.folder / 'app'
        target.mkdir()
        (target / 'important.txt').write_bytes(b'keep')
        code, result = self.invoke(target=target)
        self.assertEqual(code, 1, result)
        self.assertEqual((target / 'important.txt').read_bytes(), b'keep')

    def test_http_range_resume_and_ignored_range_are_both_correct(self):
        data = bytes(range(256)) * 40
        code, result, destination, requests = self.download(data, partial=data[:1024])
        self.assertEqual(code, 0, result)
        self.assertEqual(requests, ['bytes=1024-'])
        self.assertEqual(destination.read_bytes(), data)
        destination.unlink()
        code, result, destination, requests = self.download(data, partial=data[:1024], mode='ignore-range')
        self.assertEqual(code, 0, result)
        self.assertEqual(destination.read_bytes(), data)

    def test_a_completed_partial_is_verified_without_a_network_request(self):
        data = b'verified-complete-part'
        code, result, destination, requests = self.download(data, partial=data)
        self.assertEqual(code, 0, result)
        self.assertEqual(requests, [])
        self.assertEqual(destination.read_bytes(), data)

    def test_network_cancellation_keeps_partial_bytes_for_retry(self):
        data = bytes(range(256)) * 100
        code, result, destination, requests = self.download(data, mode='slow', cancel_ms=150)
        self.assertEqual(code, 1, result)
        self.assertTrue(result['cancelled'], result)
        self.assertFalse(destination.exists())
        self.assertGreater(destination.with_suffix('.bin.download').stat().st_size, 0)
        self.assertLess(destination.with_suffix('.bin.download').stat().st_size, len(data))

    def test_foreign_redirect_and_bad_download_hash_are_rejected(self):
        code, result, destination, _ = self.download(b'part', mode='foreign-redirect')
        self.assertEqual(code, 1, result)
        self.assertIn('跳转地址', result['error'])
        self.assertFalse(destination.exists())
        code, result, destination, _ = self.download(b'part', expected_hash='0' * 64)
        self.assertEqual(code, 1, result)
        self.assertIn('下载校验失败', result['error'])
        self.assertFalse(destination.exists())

    def test_manifest_rejects_foreign_urls_or_disguised_paths(self):
        source = json.loads(self.manifest.read_text('utf-8'))
        for url in ['http://github.com/' + REPOSITORY + '/releases/download/v-test/a',
                    'https://example.com/a', 'https://github.com/another/repo/releases/download/v-test/a',
                    PREFIX + '../secret', PREFIX + 'a?token=private']:
            value = copy.deepcopy(source)
            value['parts'][0]['url'] = url
            manifest = self.folder / 'bad-manifest.json'
            manifest.write_text(json.dumps(value), encoding='utf-8')
            self.assertEqual(self.invoke(manifest=manifest, flags=['--validate-manifest'])[0], 1, url)

    def test_manifest_rejects_wrong_lengths_and_duplicate_parts(self):
        source = json.loads(self.manifest.read_text('utf-8'))
        for mutate in [lambda value: value['parts'][0].update(bytes=2 * 1024**3),
                       lambda value: value['package'].update(bytes=1),
                       lambda value: value['parts'][1].update(fileName=value['parts'][0]['fileName']),
                       lambda value: value['parts'][0].update(fileName='install.lock', url=PREFIX + 'install.lock')]:
            value = copy.deepcopy(source)
            mutate(value)
            manifest = self.folder / 'bad-manifest.json'
            manifest.write_text(json.dumps(value), encoding='utf-8')
            self.assertEqual(self.invoke(manifest=manifest, flags=['--validate-manifest'])[0], 1)


if __name__ == '__main__':
    unittest.main()
