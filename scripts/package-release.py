"""Prepare bounded GitHub Release assets and their one-time Windows installer."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ASSET_LIMIT = 2 * 1024 ** 3


def prepare_assets(source, output, repository, tag, part_bytes=1536 * 1024 ** 2):
    source, output = Path(source).resolve(), Path(output).resolve()
    if not source.is_file() or source.is_symlink() or source.stat().st_size == 0:
        raise ValueError('发布包不存在或无效。')
    if not re.fullmatch(r'holdenxiang-eng/paper-geometry-studio-desktop', repository):
        raise ValueError('发布仓库不匹配。')
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise ValueError('发布版本号应为 v数字.数字.数字。')
    if not 0 < part_bytes < ASSET_LIMIT:
        raise ValueError('单个发布附件必须小于 2 GiB。')
    if source.is_relative_to(output):
        raise ValueError('输出目录不能包含输入ZIP。')
    output.mkdir(parents=True, exist_ok=True)
    parts, total, whole = [], 0, hashlib.sha256()
    with source.open('rb') as incoming:
        while incoming.peek(1):
            name = 'PaperStudio-Windows-x64.zip.part' + str(len(parts) + 1)
            partial, target = output / (name + '.partial'), output / name
            digest, count = hashlib.sha256(), 0
            try:
                with partial.open('wb') as outgoing:
                    while count < part_bytes:
                        block = incoming.read(min(1024 * 1024, part_bytes - count))
                        if not block:
                            break
                        outgoing.write(block)
                        digest.update(block)
                        whole.update(block)
                        count += len(block)
                partial.replace(target)
            finally:
                if partial.exists():
                    partial.unlink()
            total += count
            parts.append({'fileName': name, 'bytes': count, 'sha256': digest.hexdigest(),
                          'url': f'https://github.com/{repository}/releases/download/{tag}/{name}'})
    if total != source.stat().st_size:
        raise ValueError('切分期间发布包发生变化。')
    checksum = source.with_suffix(source.suffix + '.sha256')
    if checksum.exists() and checksum.read_text('utf-8').split()[0] != whole.hexdigest():
        raise ValueError('完整发布包与已验收校验值不符。')
    manifest = {'schema': 1, 'product': '截图组卷', 'version': tag, 'supportedWindows64': True,
                'package': {'fileName': 'PaperStudio-Windows-x64.zip', 'bytes': total, 'sha256': whole.hexdigest()},
                'parts': parts}
    destination = output / 'release-manifest.json'
    destination.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return destination, manifest


def package_release(source, output, repository, tag, part_bytes=1536 * 1024 ** 2):
    output = Path(output).resolve()
    manifest_path, manifest = prepare_assets(source, output, repository, tag, part_bytes)
    installer = output / 'PaperStudio-Setup.exe'
    subprocess.run([sys.executable, str(ROOT / 'scripts/build-installer.py'), '--repository', repository,
                    '--manifest', str(manifest_path), '--output', str(installer)], check=True)
    files = [installer, manifest_path, *(output / part['fileName'] for part in manifest['parts'])]
    lines = []
    for filename in files:
        if filename.stat().st_size >= ASSET_LIMIT:
            raise ValueError('附件超过 GitHub Release 单文件限制。')
        if filename.suffix.startswith('.part'):
            digest = next(part['sha256'] for part in manifest['parts'] if part['fileName'] == filename.name)
        else:
            with filename.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        lines.append(digest + '  ' + filename.name)
    (output / 'SHA256SUMS.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return {'output': str(output), 'installer': str(installer), 'assets': [p.name for p in files] + ['SHA256SUMS.txt'],
            'payloadBytes': manifest['package']['bytes'], 'sha256': manifest['package']['sha256']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'release/截图组卷-Windows-x64.zip')
    parser.add_argument('--repository', default='holdenxiang-eng/paper-geometry-studio-desktop')
    parser.add_argument('--tag', default='v0.1.1')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--part-mib', type=int, default=1536)
    args = parser.parse_args()
    print(json.dumps(package_release(args.source, args.output or ROOT / 'release' / ('github-' + args.tag),
                                     args.repository, args.tag, args.part_mib * 1024 ** 2), ensure_ascii=False))
