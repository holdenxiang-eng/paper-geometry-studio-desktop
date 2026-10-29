"""Build the small first-install entry from a reviewed static release manifest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def build(manifest, output, repository):
    if not re.fullmatch(r'holdenxiang-eng/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', repository):
        raise ValueError('Expected the explicitly selected holdenxiang-eng release repository')
    manifest = Path(manifest).resolve()
    if not manifest.is_file() or manifest.stat().st_size > 1024 * 1024:
        raise ValueError('A saved release manifest smaller than 1 MiB is required')
    json.loads(manifest.read_text('utf-8-sig'))
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    cache = ROOT / '.cache/installer-build'
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='build-', dir=cache) as directory:
        folder = Path(directory)
        compiled = folder / 'Installer.exe'
        policy = folder / 'repository.txt'
        policy.write_text(repository, encoding='utf-8')
        native_manifest = folder / 'application.manifest'
        native_manifest.write_text('''<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
 <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo>
 <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application></compatibility>
</assembly>''', encoding='utf-8')
        csc = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        command = [str(csc), '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output',
                   '/out:' + str(compiled), '/win32manifest:' + str(native_manifest),
                   '/resource:' + str(manifest) + ',release-manifest.json',
                   '/resource:' + str(policy) + ',installer-repository.txt']
        command += ['/reference:' + name for name in ['System.dll', 'System.Core.dll', 'System.Windows.Forms.dll',
                                                    'System.Drawing.dll', 'System.Web.Extensions.dll',
                                                    'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll']]
        command.append(str(ROOT / 'native/Installer.cs'))
        subprocess.run(command, check=True, cwd=ROOT)
        checked = folder / 'validated.json'
        subprocess.run([str(compiled), '--self-test', '--validate-manifest', '--result', str(checked)],
                       check=True, timeout=15, creationflags=0x08000000)
        if json.loads(checked.read_text('utf-8')).get('passed') is not True:
            raise ValueError('Compiled installer did not accept the embedded release manifest')
        partial = output.with_name(output.name + '.partial')
        try:
            shutil.copyfile(compiled, partial)
            partial.replace(output)
        finally:
            if partial.exists():
                partial.unlink()
    with output.open('rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    result = {'executable': str(output), 'bytes': output.stat().st_size,
              'sha256': checksum, 'repository': repository}
    print(json.dumps(result, ensure_ascii=False))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'release/截图组卷-安装.exe')
    args = parser.parse_args()
    build(args.manifest, args.output, args.repository)
