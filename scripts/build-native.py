"""Build the small WebView2 desktop host; application assets stay external."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SDK_VERSION = '1.0.4314.35'
SDK_BYTES = 9818548
SDK_SHA512 = 'cOaiVqP3BmQHMnxGpZzANM22tUXgycrisyJHjIGNzIaMsm8iXj7Kx+ceYg+RbYwJtzT009qfcFTocvVLY+ekMw=='
SDK_URL = f'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{SDK_VERSION}/microsoft.web.webview2.{SDK_VERSION}.nupkg'
# Hash and size are pinned from the official NuGet catalog record:
# https://api.nuget.org/v3/catalog0/data/2026.10.23.06.50.10/microsoft.web.webview2.1.0.4314.35.json
SDK_FILES = {
    'lib/net462/Microsoft.Web.WebView2.Core.dll': 'Microsoft.Web.WebView2.Core.dll',
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll': 'Microsoft.Web.WebView2.WinForms.dll',
    'runtimes/win-x64/native/WebView2Loader.dll': 'WebView2Loader.dll',
}


def sdk_valid(filename):
    if not filename.is_file() or filename.is_symlink() or filename.stat().st_size != SDK_BYTES:
        return False
    with filename.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha512').digest()
    return actual == base64.b64decode(SDK_SHA512, validate=True)


def obtain_sdk(cache):
    cache.mkdir(parents=True, exist_ok=True)
    filename = cache / f'microsoft.web.webview2.{SDK_VERSION}.nupkg'
    if sdk_valid(filename):
        return filename
    partial = filename.with_suffix('.partial')
    try:
        request = urllib.request.Request(SDK_URL, headers={'User-Agent': 'ScreenshotStudio-native-builder/1'})
        with urllib.request.urlopen(request, timeout=45) as response, partial.open('wb') as target:
            if response.geturl() != SDK_URL:
                raise RuntimeError('Unexpected SDK download redirect')
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > SDK_BYTES:
                    raise RuntimeError('WebView2 SDK exceeds pinned size')
                target.write(chunk)
        if not sdk_valid(partial):
            raise RuntimeError('WebView2 SDK size or official SHA512 mismatch')
        partial.replace(filename)
    finally:
        if partial.exists():
            partial.unlink()
    return filename


def copy_application(output, source_root=ROOT):
    """Copy source UI/worker code only; the installed resource tree is independent."""
    copied = []
    for name in ('ui', 'worker'):
        source = source_root / name
        if source.is_symlink() or output.resolve().is_relative_to(source.resolve()):
            raise RuntimeError('Invalid application directory boundary')
        if not source.is_dir():
            continue
        for directory, folders, files in os.walk(source, followlinks=False):
            parent = Path(directory)
            folders[:] = [item for item in folders if item not in {'__pycache__', '.cache', 'resources', 'models', 'data'}]
            for folder in folders:
                if (parent / folder).is_symlink():
                    raise RuntimeError('Linked application directories are not allowed')
            for filename in files:
                item = parent / filename
                if filename.startswith('.env') or item.suffix in {'.pyc', '.log'}:
                    continue
                if item.is_symlink() or not item.resolve().is_relative_to(source.resolve()) or item.stat().st_size > 64 * 1024 * 1024:
                    raise RuntimeError('Invalid application input')
                relative = item.relative_to(source_root)
                target = output / relative
                if not target.resolve().is_relative_to(output.resolve()):
                    raise RuntimeError('Application output escapes its directory')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(item.read_bytes())
                copied.append(relative.as_posix())
    return copied


def build(output):
    sdk = obtain_sdk(ROOT / '.cache')
    output.mkdir(parents=True, exist_ok=True)
    application_files = copy_application(output)
    with zipfile.ZipFile(sdk) as archive:
        for source, target in SDK_FILES.items():
            info = archive.getinfo(source)
            if info.file_size > 16 * 1024 * 1024:
                raise RuntimeError('Unexpected SDK assembly size')
            (output / target).write_bytes(archive.read(source))
        licenses = [name for name in archive.namelist() if name.lower().rsplit('/', 1)[-1] in {'license', 'license.txt', 'license.md'}]
        if not licenses:
            raise RuntimeError('Official SDK license is missing')
        license_dir = output / 'licenses'
        license_dir.mkdir(exist_ok=True)
        for index, name in enumerate(licenses):
            (license_dir / f'WebView2-{index + 1}.txt').write_bytes(archive.read(name))
    csc = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if not csc.is_file():
        raise RuntimeError('The Windows .NET Framework x64 compiler is unavailable')
    destination = output / '截图组卷.exe'
    command = [str(csc), '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', f'/out:{destination}']
    for name in ['System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll']:
        command.append('/reference:' + name)
    command.extend('/reference:' + str(output / name) for name in ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'])
    command.append(str(ROOT / 'native/Shell.cs'))
    subprocess.run(command, check=True, cwd=ROOT)
    manifest = {'sdkVersion': SDK_VERSION, 'sdkSource': SDK_URL, 'sdkSha512': SDK_SHA512, 'launcher': destination.name, 'applicationFiles': application_files,
                'files': {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in [destination.name, *SDK_FILES.values()]}}
    (output / 'native-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'executable': str(destination), 'bytes': destination.stat().st_size, 'sdkVersion': SDK_VERSION}, ensure_ascii=False))
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    build(args.output.resolve())
