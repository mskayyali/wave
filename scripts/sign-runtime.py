#!/usr/bin/env python3
"""Sign bundled runtime code before Tauri seals the app, or verify its team."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root', type=Path)
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument('--identity')
mode.add_argument('--verify-team')
args = parser.parse_args()
root = args.root.resolve(strict=True)
magic = {
    b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe',
    b'\xfe\xed\xfa\xcf', b'\xfe\xed\xfa\xce',
    b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf',
    b'\xbe\xba\xfe\xca', b'\xbf\xba\xfe\xca',
}
targets = []
for path in sorted(root.rglob('*')):
    if path.is_symlink() or not path.is_file():
        continue
    with path.open('rb') as stream:
        if stream.read(4) in magic:
            targets.append(path)
if not targets:
    raise SystemExit('No runtime executables or libraries found; refusing to proceed.')
for path in targets:
    if args.identity:
        subprocess.run(['codesign', '--force', '--sign', args.identity,
                        '--options', 'runtime', '--timestamp', str(path)], check=True)
    subprocess.run(['codesign', '--verify', '--strict', str(path)], check=True)
    if args.verify_team:
        info = subprocess.run(['codesign', '-dv', str(path)],
                              capture_output=True, text=True, check=True)
        if f'TeamIdentifier={args.verify_team}' not in info.stderr.splitlines():
            raise SystemExit(f'Runtime signing team differs from Wave: {path}')
print(f'{"Signed" if args.identity else "Verified"} {len(targets)} runtime executables and libraries.')
