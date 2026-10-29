"""Prepare app-local Microsoft x64 CRT files; never install system components.

This build-time step uses the licensed Visual Studio redistributable directory,
not System32. WebView2 remains the system prerequisite chosen for this product.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CRT_VERSION = '14.44.35112'
CRT_FILES = {
    'concrt140.dll': (324208, '2405355f0a58067b258f8df33c327e3a3d716eaac5a3a5aebb757842d85bd376'),
    'msvcp140.dll': (557728, '0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9'),
    'msvcp140_1.dll': (35952, 'bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d'),
    'msvcp140_2.dll': (280200, '3ea06f0ee098b4823cb79599df3780e7f23cce52c19aac31d2a0d47efe33a5e9'),
    'msvcp140_atomic_wait.dll': (50304, '640b2aefced484d0368eea5bdd06addd0658a3a70a49256e560d6923b404a479'),
    'msvcp140_codecvt_ids.dll': (31872, 'f2069a52880ec885ee7f0511186100eb7fada0411a2b4948fafea7735b878a18'),
    'vccorlib140.dll': (352384, '19839407c3fdbc824e5bce189bf68ddf8097f12ec28b757797ffa0415c144ddd'),
    'vcruntime140.dll': (124544, 'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066'),
    'vcruntime140_1.dll': (49792, '1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f'),
    'vcruntime140_threads.dll': (38528, '219915cf20822f34d5e7c1fdd4e21ae7f3396881096c51036225fb8f84b47afa'),
}
LICENSES = {
    'Visual-C-Runtime-2015-2022-License.txt': (
        'https://visualstudio.microsoft.com/wp-content/uploads/2021/09/Visual-C-Runtime-2015-2022-License-1.docx',
        39644, 'f1e3d56ceb2ad68aae0711b910375009e651ac5530fa0760f0dea6e81e54fae1',
        6624, '2dd434a15fb5f9d28c33211a5af471eb719acba5db65e5103e0db95e7869a2fb'),
    'Visual-Studio-2022-Community-License.txt': (
        'https://visualstudio.microsoft.com/wp-content/uploads/2021/11/Visual-Studio-2022-Community-License-EN.docx',
        62859, '41a207b10c8ab91d0d2f10a854715f73dca54509581692d2fe179aa3ffcb8540',
        19043, 'a38d10afc3ef8fb2e64af972a9c64d998ef964de8101b9f7a59703f72fa3a5ab'),
    'Visual-Studio-2022-Build-Tools-License.txt': (
        'https://visualstudio.microsoft.com/wp-content/uploads/2024/03/Visual-Studio-2022-Diagnostic-Build-Tools-Agent-License_Update-March-2024_EN.docx',
        34395, '2f66b86a00e8d9833789897ce23d05a4a2dbea370cf39c8c1098dbc17d0e7bdc',
        11288, 'c577c6137db9df991585f4988c019761b8dd59578870925b401327ffa3a285aa'),
}
TARGETS = ('python', 'vision/llama', 'python/Lib/site-packages/onnxruntime/capi')
PREREQUISITES = ('python/python.exe', 'vision/llama/llama-server.exe',
                 'python/Lib/site-packages/onnxruntime/capi/onnxruntime_pybind11_state.pyd')
REDISTRIBUTION_URL = 'https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution#visual-c-runtime-files'
DEPLOYMENT_URL = 'https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files#install-individual-redistributable-files'


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def linked(path):
    return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def verified(path, size, expected):
    return path.is_file() and not linked(path) and path.stat().st_size == size and digest(path) == expected


def default_source():
    base = Path(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)')) / 'Microsoft Visual Studio/2022'
    for edition in ('BuildTools', 'Community', 'Professional', 'Enterprise'):
        candidate = base / edition / f'VC/Redist/MSVC/{CRT_VERSION}/x64/Microsoft.VC143.CRT'
        if candidate.is_dir():
            return candidate
    raise RuntimeError('未找到锁定的 Visual Studio x64 Redist，请显式传入 --crt-source；不能使用 System32 或 debug_nonredist。')


def validate_source(source):
    source = Path(source)
    parts = [part.casefold() for part in source.parts]
    if linked(source) or source.name != 'Microsoft.VC143.CRT' or source.parent.name != 'x64' or 'debug_nonredist' in parts or 'system32' in parts:
        raise ValueError('必须使用 Visual Studio 的非调试 x64 Microsoft.VC143.CRT 发布目录。')
    for name, (size, expected) in CRT_FILES.items():
        if not verified(source / name, size, expected):
            raise ValueError('CRT 文件与锁定的微软发布版本不符：' + name)
    return source.resolve()


def local_target(root, relative):
    result = root / relative
    if not result.resolve().is_relative_to(root.resolve()):
        raise ValueError('应用本地 CRT 目标路径越界。')
    if result.exists() and linked(result):
        raise ValueError('应用本地 CRT 目标不能是链接。')
    return result


def license_file(cache, name, url, size, expected, text_size, text_sha):
    result = cache / name
    if verified(result, text_size, text_sha):
        return result
    partial = result.with_suffix('.partial')
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'ScreenshotStudio-CRT-build/1'})
        with urllib.request.urlopen(request, timeout=45) as source:
            if source.geturl() != url:
                raise ValueError('微软许可下载出现非预期重定向。')
            data = source.read(size + 1)
        if len(data) != size or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError('微软许可文件大小或 SHA256 不符。')
        # Keep the official DOCX response only in memory. Publish its complete
        # text, recording both the source hash and the derived UTF-8 text hash.
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            document = ET.fromstring(archive.read('word/document.xml'))
        text = '\n'.join(''.join(paragraph.itertext()) for paragraph in document.findall('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'))
        derived = (text + '\n').encode('utf-8')
        if len(derived) != text_size or hashlib.sha256(derived).hexdigest() != text_sha:
            raise ValueError('微软许可全文提取结果与锁定值不符。')
        partial.write_bytes(derived)
        partial.replace(result)
    finally:
        partial.unlink(missing_ok=True)
    return result


def prepare(dist, crt_source=None, *, license_cache=None):
    dist = Path(dist).resolve()
    resources = dist / 'resources'
    if not resources.is_dir() or linked(resources):
        raise ValueError('请先准备新应用 resources 目录。')
    for relative in PREREQUISITES:
        if not local_target(resources, relative).is_file():
            raise ValueError('请先运行 setup-worker.py 准备识别依赖：' + relative)
    source = validate_source(crt_source if crt_source is not None else default_source())
    cache = Path(license_cache) if license_cache else ROOT / '.cache/desktop-runtime'
    cache.mkdir(parents=True, exist_ok=True)
    # Validate all inputs before changing the existing application runtime.
    licenses = {name: license_file(cache, name, *values) for name, values in LICENSES.items()}
    targets = [local_target(resources, relative) for relative in TARGETS]
    notice_dir = local_target(resources, 'licenses/msvc')
    notice_dir.mkdir(parents=True, exist_ok=True)
    records = []
    for folder in targets:
        for name, (size, expected) in CRT_FILES.items():
            target = local_target(resources, folder.relative_to(resources) / name)
            shutil.copyfile(source / name, target)
            if not verified(target, size, expected):
                raise ValueError('应用本地 CRT 写入验证失败：' + name)
            records.append({'file': target.relative_to(resources).as_posix(), 'bytes': size, 'sha256': expected})
    for name, original in licenses.items():
        target = local_target(resources, Path('licenses/msvc') / name)
        shutil.copyfile(original, target)
    notice = ('Microsoft Visual C++ 2015-2022 app-local runtime\n'
              f'Version: {CRT_VERSION}, architecture: x64. Files are unmodified copies from the licensed Visual Studio VC/Redist/MSVC directory.\n'
              'This is part of Screenshot Studio, not a standalone redistribution of Microsoft tools.\n'
              'Redistribution rights are governed by the applicable Visual Studio product license and the official REDIST list; the runtime use license is also supplied.\n'
              f'Official distributable list: {REDISTRIBUTION_URL}\nOfficial app-local deployment documentation: {DEPLOYMENT_URL}\n'
              'The included Community, Build Tools, and Runtime licenses contain the complete UTF-8 text extracted from verified official Microsoft DOCX responses in memory. Source URLs, original-response hashes and derived-text hashes are recorded in desktop-runtime-lock.json. No DOCX binary is distributed.\n')
    local_target(resources, 'licenses/msvc/NOTICE.txt').write_text(notice, encoding='utf-8')
    manifest = {'schema': 1, 'kind': 'app-local-msvc-crt', 'version': CRT_VERSION, 'architecture': 'x64',
                'source': f'Visual Studio/VC/Redist/MSVC/{CRT_VERSION}/x64/Microsoft.VC143.CRT',
                'redistribution': REDISTRIBUTION_URL, 'files': records,
                'licenses': [{'file': f'licenses/msvc/{name}', 'url': value[0], 'sourceBytes': value[1], 'sourceSha256': value[2],
                              'bytes': value[3], 'sha256': value[4]} for name, value in LICENSES.items()]}
    local_target(resources, 'desktop-runtime-lock.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return {'state': 'ready', 'version': CRT_VERSION, 'files': len(records), 'bytes': sum(value['bytes'] for value in records),
            'manifest': str(resources / 'desktop-runtime-lock.json'), 'systemInstallation': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
    parser.add_argument('--crt-source', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(prepare(arguments.dist, arguments.crt_source), ensure_ascii=False))
