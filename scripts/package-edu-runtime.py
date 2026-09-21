"""Package a locally built standalone app without credentials or runtime data.

Usage: python3 scripts/package-edu-runtime.py /tmp/edu-runtime.tar.gz
Linux-native dependencies are restored by deploy/Dockerfile.prebuilt.
"""
from pathlib import Path
import sys
import tarfile

root = Path(__file__).resolve().parents[1]
standalone = root / '.next/standalone'
if not (standalone / 'server.js').is_file():
    raise SystemExit('Run the production build first.')
output = Path(sys.argv[1]).resolve()
if output.is_relative_to(standalone):
    raise SystemExit('The archive must be outside the standalone directory.')
with tarfile.open(output, 'w:gz') as archive:
    for file in standalone.rglob('*'):
        relative = file.relative_to(standalone)
        if any(part.startswith(('.env', 'client_secret_')) or part in ('data', 'logs', '.git') for part in relative.parts):
            continue
        archive.add(file, arcname=str(relative), recursive=False)
    for source, prefix in [(root / '.next/static', '.next/static'), (root / 'public', 'public')]:
        for file in source.rglob('*'):
            archive.add(file, arcname=str(Path(prefix) / file.relative_to(source)), recursive=False)
print(output)
