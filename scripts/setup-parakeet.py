#!/usr/bin/env python3
"""Fetch the pinned native runtime; never run an upstream install script."""
import hashlib
import io
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
import urllib.request

VERSION = '0.3.0'
ARCHIVE = f'nemo-speech-{VERSION}-macos-aarch64-metal.tar.gz'
SHA256 = '2b972ed8b5dba07492212acf8cb75cbf34ecb141198ffa1997febe84b7c4d9ed'
DEST = Path(__file__).resolve().parents[1] / 'src-tauri/vendor/nemo-speech/runtime'

if platform.system() != 'Darwin' or platform.machine() != 'arm64':
    raise SystemExit('The bundled Parakeet runtime requires an Apple Silicon Mac.')
url = f'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v{VERSION}/{ARCHIVE}'
with urllib.request.urlopen(url, timeout=60) as response:
    data = response.read()
if hashlib.sha256(data).hexdigest() != SHA256:
    raise SystemExit('Runtime checksum mismatch; nothing installed.')
DEST.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(dir=DEST.parent) as staging:
    root = Path(staging)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        # Reject paths/links outside the staging directory, including symlinks.
        for member in archive.getmembers():
            target = (root / member.name).resolve()
            if not target.is_relative_to(root):
                raise SystemExit('Unsafe archive path.')
            if member.issym() or member.islnk():
                link = (target.parent / member.linkname).resolve() if member.issym() else (root / member.linkname).resolve()
                if not link.is_relative_to(root):
                    raise SystemExit('Unsafe archive link.')
        archive.extractall(root)
    source = root / ARCHIVE.removesuffix('.tar.gz')
    if DEST.exists():
        shutil.rmtree(DEST)
    shutil.move(source, DEST)
print(f'Installed verified NeMo-Speech.cpp {VERSION}.')
