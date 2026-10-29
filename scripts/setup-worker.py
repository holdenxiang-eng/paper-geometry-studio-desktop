"""Prepare the new app's isolated Windows Python/OCR worker from official sources.

No global packages, user credentials, or screenshot uploads are used. All caches
and an exact downloaded-file SHA256 audit live under next/dist/resources.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "dist/resources"
PYTHON_VERSION = "3.12.10"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
PYTHON_SHA256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
# Exact package versions; only CPython 3.12 / Windows x64 or compatible abi3
# wheels are accepted. OpenCV is deliberately headless for both OCR adapters.
PACKAGES = {
    "rapidocr": "3.10.0", "rapid-latex-ocr": "0.0.9",
    "onnxruntime": "1.23.2", "numpy": "1.26.4",
    "opencv-python-headless": "4.11.0.86", "pillow": "11.3.0",
    "tokenizers": "0.22.2", "pyyaml": "6.0.3", "chardet": "5.2.0",
    "pyclipper": "1.4.0", "shapely": "2.1.2", "six": "1.17.0",
    "tqdm": "4.67.1", "omegaconf": "2.3.0", "requests": "2.32.5",
    "colorlog": "6.10.1", "huggingface-hub": "0.36.0",
    "filelock": "3.19.1", "fsspec": "2025.9.0", "packaging": "25.0",
    "typing-extensions": "4.15.0", "hf-xet": "1.2.0",
    "certifi": "2025.10.5", "charset-normalizer": "3.4.4",
    "idna": "3.11", "urllib3": "2.5.0", "coloredlogs": "15.0.1",
    "humanfriendly": "10.0", "flatbuffers": "25.9.23",
    "protobuf": "6.33.0", "sympy": "1.14.0", "mpmath": "1.3.0",
    "colorama": "0.4.6",
    "python-docx": "1.2.0", "latex2mathml": "3.81.1",
    "mathml2omml": "0.0.2", "lxml": "6.0.2",
}
FORMULA_FILES = ("encoder.onnx", "decoder.onnx", "image_resizer.onnx", "tokenizer.json")
FORMULA_BASE = "https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0/"
VISION_ASSETS = {
    "llama-b11913-bin-win-cpu-x64.zip": "55b31ccaf398e90457cfe28087297f5f3fdf1e3bfa7a28e1108f13d0af8e4621",
    "Qwen3VL-4B-Instruct-Q4_K_M.gguf": "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a",
    "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf": "30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d",
}
QWEN_REVISION = '1cd86afb9a95c410a6038ab3b40d8b578c892266'
QWEN_BASE = f'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/{QWEN_REVISION}/'
VISION_URLS = {
    'llama-b11913-bin-win-cpu-x64.zip': 'https://github.com/ggml-org/llama.cpp/releases/download/b11913/llama-b11913-bin-win-cpu-x64.zip',
    'Qwen3VL-4B-Instruct-Q4_K_M.gguf': QWEN_BASE + 'Qwen3VL-4B-Instruct-Q4_K_M.gguf',
    'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf': QWEN_BASE + 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
}
VISION_LICENSES = {
    'llama.cpp-MIT.txt': {
        'url': 'https://raw.githubusercontent.com/ggml-org/llama.cpp/b11913/LICENSE',
        'sha256': '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
    },
    'Qwen3-VL-Apache-2.0.txt': {
        'url': 'https://raw.githubusercontent.com/QwenLM/Qwen3-VL/e8c6dfbe0472e567b1bedc7640f550e0e506429f/LICENSE',
        'sha256': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    },
}
OCR_MODELS = {
    'PP-OCRv6/det/PP-OCRv6_det_small.onnx': '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f',
    'PP-OCRv6/rec/PP-OCRv6_rec_small.onnx': '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
    'PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx': 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c',
}


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def get_json(url: str):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "PaperStudioNext-build/1"}), timeout=60) as response:
        return json.load(response)


def download(url: str, filename: Path, expected: str | None = None) -> dict:
    filename.parent.mkdir(parents=True, exist_ok=True)
    if not filename.exists() or expected and sha256(filename) != expected:
        partial = filename.with_name(filename.name + ".partial")
        request = urllib.request.Request(url, headers={"User-Agent": "PaperStudioNext-build/1"})
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        if expected and sha256(partial) != expected:
            raise RuntimeError("SHA256 mismatch: " + filename.name)
        partial.replace(filename)
    record = {"file": filename.relative_to(RESOURCES).as_posix(), "url": url,
              "bytes": filename.stat().st_size, "sha256": sha256(filename)}
    print(json.dumps({"state": "verified", "file": record["file"], "bytes": record["bytes"]}), flush=True)
    return record


def safe_target(root: Path, name: str) -> Path:
    relative = Path(name.replace("\\", "/"))
    result = (root / relative).resolve()
    if relative.is_absolute() or ":" in name or ".." in relative.parts or not result.is_relative_to(root.resolve()):
        raise ValueError("Archive path escapes runtime")
    return result


def unpack_zip(archive: Path, destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            target = safe_target(destination, entry.filename)
            if (entry.external_attr >> 16) & 0xF000 == 0xA000:
                raise ValueError("Linked archive entries are not accepted")
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(entry) as incoming, target.open("wb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)


def wheel_score(filename: str) -> int:
    if not filename.endswith(".whl"):
        return -1
    if filename.endswith("-cp312-cp312-win_amd64.whl"):
        return 30
    match = re.search(r"-cp3(\d+)-abi3-win_amd64\.whl$", filename)
    if match and int(match[1]) <= 12:
        return 20 + int(match[1]) / 100
    if filename.endswith(("-py3-none-any.whl", "-py2.py3-none-any.whl")):
        return 10
    return -1


def prepare_ocr_models():
    # These URLs and hashes are pinned by RapidOCR 3.10.0 default_models.yaml.
    root = RESOURCES / 'python/Lib/site-packages/rapidocr/models'
    return [download('https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/' + name,
                     root / Path(name).name, expected) for name, expected in OCR_MODELS.items()]


def prepare(include_formula: bool):
    cache = RESOURCES / "download-cache"
    python = RESOURCES / "python"
    site = python / "Lib/site-packages"
    audit_path = RESOURCES / "worker-lock.json"
    previous = json.loads(audit_path.read_text("utf-8")) if audit_path.exists() else {"files": []}
    pinned = {entry["url"]: entry["sha256"] for entry in previous["files"]}
    audit = []
    archive = cache / f"python-{PYTHON_VERSION}-embed-amd64.zip"
    audit.append(download(PYTHON_URL, archive, PYTHON_SHA256))
    unpack_zip(archive, python)
    (python / "python312._pth").write_text("python312.zip\n.\nLib/site-packages\nimport site\n", encoding="utf-8")
    for name, version in PACKAGES.items():
        if not include_formula and name in {"rapid-latex-ocr", "tokenizers", "chardet", "huggingface-hub", "hf-xet", "filelock", "fsspec"}:
            continue
        metadata = get_json(f"https://pypi.org/pypi/{name}/{version}/json")
        candidates = [entry for entry in metadata["urls"] if wheel_score(entry["filename"]) >= 0]
        if not candidates:
            raise RuntimeError("No pinned Windows/Python3.12 wheel: " + name)
        entry = max(candidates, key=lambda item: wheel_score(item["filename"]))
        wheel = cache / entry["filename"]
        audit.append(download(entry["url"], wheel, entry["digests"]["sha256"]))
        unpack_zip(wheel, site)
    # OmegaConf's pinned ANTLR runtime is pure Python but has no upstream wheel.
    metadata = get_json("https://pypi.org/pypi/antlr4-python3-runtime/4.9.3/json")
    entry = next(item for item in metadata["urls"] if item["packagetype"] == "sdist")
    archive = cache / entry["filename"]
    audit.append(download(entry["url"], archive, entry["digests"]["sha256"]))
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            if not member.isfile():
                continue
            parts = Path(member.name).parts
            if "antlr4" not in parts:
                continue
            target = safe_target(site, "/".join(parts[parts.index("antlr4"):]))
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as incoming, target.open("wb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
    if include_formula:
        for name in FORMULA_FILES:
            url = FORMULA_BASE + name
            audit.append(download(url, RESOURCES / "models/formula" / name, pinned.get(url)))
    for name, url in {
        "RapidOCR-LICENSE.txt": "https://raw.githubusercontent.com/RapidAI/RapidOCR/main/LICENSE",
        "RapidLaTeXOCR-LICENSE.txt": "https://raw.githubusercontent.com/RapidAI/RapidLaTeXOCR/main/LICENSE",
    }.items():
        audit.append(download(url, RESOURCES / "licenses" / name, pinned.get(url)))
    audit.extend(prepare_ocr_models())
    audit_path.write_text(json.dumps({"schema": 1, "python": PYTHON_VERSION, "packages": PACKAGES, "files": audit}, indent=2), encoding="utf-8")
    print(json.dumps({"state": "ready", "python": str(python / "python.exe"), "formula": include_formula}), flush=True)


def prepare_vision(source: Path | None = None):
    """Download pinned public assets, or explicitly reuse verified local files."""
    destination = RESOURCES / "vision"
    destination.mkdir(parents=True, exist_ok=True)
    records = []
    for name, expected in VISION_ASSETS.items():
        url = VISION_URLS[name]
        original = source / name if source is not None else None
        if original is not None and (not original.is_file() or original.is_symlink() or sha256(original) != expected):
            raise RuntimeError('Existing public vision asset does not match its pinned SHA256: ' + name)
        if name.endswith('.zip'):
            if original is None:
                original = RESOURCES / 'download-cache' / name
                download(url, original, expected)
            unpack_zip(original, destination / 'llama')
            target = destination / 'llama/llama-server.exe'
            if not target.is_file():
                raise RuntimeError('CPU runtime archive has no llama-server.exe')
        else:
            target = destination / name
            if target.exists():
                if not target.is_file() or target.is_symlink() or sha256(target) != expected:
                    raise RuntimeError('Do not overwrite a different vision model: ' + name)
            elif original is not None:
                try:
                    target.hardlink_to(original)
                except OSError:
                    shutil.copyfile(original, target)
                if sha256(target) != expected:
                    raise RuntimeError('Copied vision model did not verify: ' + name)
            else:
                download(url, target, expected)
        records.append({'name': name, 'url': url, 'sha256': expected})
        print(json.dumps({'state': 'vision-verified', 'name': name}), flush=True)
    licenses = [download(record['url'], RESOURCES / 'licenses/vision' / name, record['sha256'])
                for name, record in VISION_LICENSES.items()]
    (destination / 'assets-lock.json').write_text(json.dumps({'schema': 1, 'files': records, 'licenses': licenses}, indent=2), encoding='utf-8')


def prepare_word():
    audit_path = RESOURCES / 'worker-lock.json'
    audit = json.loads(audit_path.read_text('utf-8'))
    for name in ('python-docx', 'latex2mathml', 'mathml2omml', 'lxml'):
        version = PACKAGES[name]
        metadata = get_json(f'https://pypi.org/pypi/{name}/{version}/json')
        entry = max((value for value in metadata['urls'] if wheel_score(value['filename']) >= 0), key=lambda value: wheel_score(value['filename']))
        wheel = RESOURCES / 'download-cache' / entry['filename']
        record = download(entry['url'], wheel, entry['digests']['sha256'])
        unpack_zip(wheel, RESOURCES / 'python/Lib/site-packages')
        audit['packages'][name] = version
        audit['files'] = [value for value in audit['files'] if value['file'] != record['file']] + [record]
    audit_path.write_text(json.dumps(audit, indent=2), encoding='utf-8')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--with-formula-experiment", action="store_true", help='Optional, not the default recognized-math provider')
    parser.add_argument("--vision-only", action="store_true", help='Prepare vision resources without reinstalling OCR')
    parser.add_argument("--word-only", action="store_true", help='Prepare only the four pinned Word export dependencies')
    parser.add_argument("--vision-assets-from", type=Path, help='Explicitly reuse pinned public assets from this directory; otherwise download official fixed revisions')
    args = parser.parse_args()
    if args.word_only:
        prepare_word()
    else:
        if not args.vision_only:
            prepare(args.with_formula_experiment)
        prepare_vision(args.vision_assets_from.resolve() if args.vision_assets_from else None)
