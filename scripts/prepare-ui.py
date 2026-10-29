"""Copy only pinned public browser libraries into the new application's UI."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'ui/vendor'


def main():
    modules = ROOT / 'node_modules' if (ROOT / 'node_modules/katex').is_dir() else ROOT.parent / 'node_modules'
    expected = {'katex': '0.16.47', 'jsxgraph': '1.14.1'}
    versions = {}
    for name, version in expected.items():
        package = modules / name
        actual = json.loads((package / 'package.json').read_text(encoding='utf-8'))['version']
        if actual != version:
            raise RuntimeError(f'{name} must be pinned to {version}, found {actual}')
        versions[name] = actual
    VENDOR.mkdir(parents=True, exist_ok=True)
    for name in ('katex.min.js', 'katex.min.css'):
        shutil.copy2(modules / 'katex/dist' / name, VENDOR / name)
    shutil.copytree(modules / 'katex/dist/fonts', VENDOR / 'fonts', dirs_exist_ok=True)
    shutil.copy2(modules / 'katex/LICENSE', VENDOR / 'LICENSE.katex')
    for name in ('jsxgraphcore.js', 'jsxgraph.css'):
        shutil.copy2(modules / 'jsxgraph/distrib' / name, VENDOR / name)
    for name in ('LICENSE.MIT', 'LICENSE'):
        candidate = modules / 'jsxgraph' / name
        if candidate.is_file():
            shutil.copy2(candidate, VENDOR / 'LICENSE.jsxgraph')
            break
    print(json.dumps({'browserLibraries': versions}, ensure_ascii=False))


if __name__ == '__main__':
    main()
