"""Package the already built new application; never download or self-extract."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NATIVE_FILES = ('截图组卷.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
REQUIRED_FILES = (*NATIVE_FILES, 'native-manifest.json', 'ui/index.html', 'ui/app.js', 'ui/core/document.js',
                  'ui/core/render.js', 'ui/vendor/katex.min.js', 'ui/vendor/katex.min.css', 'ui/vendor/jsxgraphcore.js',
                  'worker/service.py', 'worker/document.py', 'worker/vision.py', 'worker/export_word.py',
                  'licenses/WebView2-1.txt', 'resources/worker-lock.json', 'resources/vision/assets-lock.json',
                  'resources/desktop-runtime-lock.json',
                  'resources/python/msvcp140.dll', 'resources/python/msvcp140_1.dll',
                  'resources/vision/llama/msvcp140.dll', 'resources/vision/llama/vcruntime140.dll',
                  'resources/python/Lib/site-packages/onnxruntime/capi/msvcp140.dll',
                  'resources/python/Lib/site-packages/onnxruntime/capi/msvcp140_1.dll',
                  'resources/licenses/msvc/Visual-C-Runtime-2015-2022-License.txt',
                  'resources/licenses/vision/llama.cpp-MIT.txt', 'resources/licenses/vision/Qwen3-VL-Apache-2.0.txt',
                  'resources/vision/Qwen3VL-4B-Instruct-Q4_K_M.gguf', 'resources/vision/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
                  'resources/vision/llama/llama-server.exe', 'resources/python/python.exe', 'resources/python/python312.dll',
                  'resources/python/python312.zip', 'resources/python/python312._pth',
                  'resources/python/Lib/site-packages/docx/api.py',
                  'resources/python/Lib/site-packages/latex2mathml/converter.py',
                  'resources/python/Lib/site-packages/mathml2omml/__init__.py',
                  'resources/python/Lib/site-packages/rapidocr/__init__.py',
                  'resources/python/Lib/site-packages/rapidocr/models/PP-OCRv6_det_small.onnx',
                  'resources/python/Lib/site-packages/rapidocr/models/PP-OCRv6_rec_small.onnx',
                  'resources/python/Lib/site-packages/rapidocr/models/ch_ppocr_mobile_v2.0_cls_mobile.onnx')
DIRECTORIES = ('ui', 'worker', 'resources', 'licenses')
EXCLUDED_PARTS = {'data', 'download-cache', 'cache', '.cache', 'logs', 'log', 'temp', 'tmp', '__pycache__',
                  'tests', 'test', 'screenshots', 'captures', '.git', '.pytest_cache', '.mypy_cache', '.ruff_cache'}
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'}


def digest(filename):
    with filename.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def linked(filename):
    return filename.is_symlink() or bool(getattr(filename.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def excluded(relative, is_directory=False):
    parts = tuple(part.casefold() for part in relative.parts)
    name, suffix = parts[-1], relative.suffix.casefold()
    if any(part in EXCLUDED_PARTS for part in parts) or any(part.startswith('.env') for part in parts):
        return True
    # These ONNX models are an explicitly optional experiment, not the provider
    # used by worker/service.py and worker/vision.py. Source files stay untouched.
    if parts[:3] == ('resources', 'models', 'formula'):
        return True
    if is_directory:
        return False
    if name in {'.gitkeep', '.gitignore', '.gitattributes'} or suffix in {'.pyc', '.pyo', '.log', '.key', '.pfx', '.p12'} or name.endswith('.paper.json'):
        return True
    if suffix in IMAGE_SUFFIXES or name.startswith('test_') or '.test.' in name:
        return True
    if suffix == '.pem' and parts[-2:] != ('certifi', 'cacert.pem'):
        return True
    if parts[0] == 'worker' and suffix != '.py':
        return True
    if parts[:3] == ('resources', 'vision', 'llama'):
        return not (name == 'llama-server.exe' or suffix == '.dll' or name.startswith(('license', 'notice', 'copying')))
    return False


def collect_files(dist):
    dist = Path(dist).resolve()
    if not dist.is_dir() or linked(dist):
        raise ValueError('发布输入目录无效或包含链接。')
    files = []
    for name in (*NATIVE_FILES, 'native-manifest.json'):
        candidate = dist / name
        if candidate.is_file():
            if linked(candidate):
                raise ValueError('发布文件不能是链接：' + name)
            files.append((name, candidate))
    for name in DIRECTORIES:
        root = dist / name
        if not root.is_dir():
            continue
        if linked(root):
            raise ValueError('发布目录不能是链接：' + name)
        for directory, folders, filenames in os.walk(root, followlinks=False):
            parent = Path(directory)
            accepted = []
            for folder in folders:
                candidate = parent / folder
                relative = candidate.relative_to(dist)
                if excluded(relative, is_directory=True):
                    continue
                if linked(candidate):
                    raise ValueError('发布目录不能包含链接：' + relative.as_posix())
                accepted.append(folder)
            folders[:] = accepted
            for filename in filenames:
                candidate = parent / filename
                relative = candidate.relative_to(dist)
                if excluded(relative):
                    continue
                if linked(candidate) or not candidate.resolve().is_relative_to(dist):
                    raise ValueError('发布文件越界或包含链接：' + relative.as_posix())
                files.append((relative.as_posix(), candidate))
    return sorted(files)


def validate_files(dist, files):
    by_name = dict(files)
    for name in REQUIRED_FILES:
        if name not in by_name or not by_name[name].stat().st_size:
            raise ValueError('发布缺少必要文件：' + name)
    manifest = json.loads((dist / 'native-manifest.json').read_text('utf-8'))
    for name in NATIVE_FILES:
        if manifest.get('files', {}).get(name) != digest(dist / name):
            raise ValueError('宿主/SDK SHA256 与构建清单不符，请重新构建：' + name)
    for name in manifest.get('applicationFiles', []):
        if not isinstance(name, str) or name not in by_name:
            raise ValueError('构建清单中的应用文件未进入发布：' + str(name))
        source = (ROOT / name).resolve()
        if not source.is_relative_to(ROOT) or not source.is_file():
            raise ValueError('应用源文件不存在或越界：' + name)
        if digest(source) != digest(by_name[name]):
            raise ValueError('应用文件已修改，请先重新运行 build-native.py：' + name)


def locked_hashes(dist):
    result = {}
    for item in json.loads((dist / 'resources/worker-lock.json').read_text('utf-8')).get('files', []):
        if isinstance(item.get('file'), str) and isinstance(item.get('sha256'), str):
            result['resources/' + item['file']] = item['sha256']
    for item in json.loads((dist / 'resources/vision/assets-lock.json').read_text('utf-8')).get('files', []):
        if isinstance(item.get('name'), str) and isinstance(item.get('sha256'), str):
            result['resources/vision/' + item['name']] = item['sha256']
    desktop = json.loads((dist / 'resources/desktop-runtime-lock.json').read_text('utf-8'))
    for item in desktop.get('files', []) + desktop.get('licenses', []):
        if isinstance(item.get('file'), str) and isinstance(item.get('sha256'), str):
            result['resources/' + item['file']] = item['sha256']
    return result


def build_package(dist, output, dry_run=False):
    dist, output = Path(dist).resolve(), Path(output).resolve()
    if output.is_relative_to(dist):
        raise ValueError('ZIP 输出必须位于 dist 之外，避免把发布包再次打入自身。')
    files = collect_files(dist)
    validate_files(dist, files)
    summary = {'archive': str(output), 'root': '截图组卷', 'files': len(files), 'inputBytes': sum(path.stat().st_size for _, path in files),
               'excludedOptionalModels': ['resources/models/formula'], 'selfExtracting': False}
    if dry_run:
        return {**summary, 'dryRun': True}
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.name + '.partial')
    snapshots = {name: (path.stat().st_size, path.stat().st_mtime_ns) for name, path in files}
    expected = locked_hashes(dist)
    try:
        with zipfile.ZipFile(partial, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name, source in files:
                info = zipfile.ZipInfo('截图组卷/' + name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED if source.suffix.casefold() in {'.gguf', '.onnx', '.zip', '.woff2'} else zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                info.file_size = snapshots[name][0]
                hashed = hashlib.sha256()
                with source.open('rb') as incoming, archive.open(info, 'w', force_zip64=True) as outgoing:
                    while chunk := incoming.read(1024 * 1024):
                        outgoing.write(chunk)
                        hashed.update(chunk)
                if name in expected and hashed.hexdigest() != expected[name]:
                    raise ValueError('资源 SHA256 与锁文件不符：' + name)
        for name, source in files:
            if (source.stat().st_size, source.stat().st_mtime_ns) != snapshots[name]:
                raise ValueError('打包期间输入发生变化，请冻结后重试：' + name)
        with zipfile.ZipFile(partial) as archive:
            if archive.testzip() is not None:
                raise ValueError('ZIP CRC 校验失败。')
        partial.replace(output)
        checksum = digest(output)
        output.with_suffix(output.suffix + '.sha256').write_text(checksum + '  ' + output.name + '\n', encoding='utf-8')
        return {**summary, 'bytes': output.stat().st_size, 'sha256': checksum}
    finally:
        if partial.exists():
            partial.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, default=ROOT / 'release/截图组卷-Windows-x64.zip')
    parser.add_argument('--dry-run', action='store_true', help='Validate paths/content without reading or writing the large model payload')
    arguments = parser.parse_args()
    print(json.dumps(build_package(arguments.dist, arguments.output, arguments.dry_run), ensure_ascii=False))
