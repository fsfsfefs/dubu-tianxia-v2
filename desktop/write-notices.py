"""Include redistributable dependency notices; never scan application user data."""
import importlib.metadata as metadata
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output_root = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'dist/windows'
output = output_root / 'DubuTianxia/THIRD-PARTY-NOTICES.txt'
sections = ['读步天下第二版 - third-party dependency notices', 'Python runtime: https://docs.python.org/3/license.html']
python_license = Path(sys.base_prefix) / 'LICENSE.txt'
if not python_license.is_file():
    raise SystemExit('Python runtime license is missing.')
sections.append(python_license.read_text(encoding='utf-8'))
for dist in sorted(metadata.distributions(), key=lambda d: d.metadata['Name'].lower()):
    if dist.metadata['Name'].lower() in {'reader-next-api', 'pip', 'pytest', 'pyinstaller', 'pyinstaller-hooks-contrib', 'setuptools', 'wheel'}:
        continue
    texts = []
    for file in dist.files or []:
        if any(marker in file.name.lower() for marker in ('license', 'copying', 'notice')) and not str(file).endswith(('.py', '.pyc')):
            path = dist.locate_file(file)
            if path.is_file() and path.stat().st_size < 250_000:
                texts.append(path.read_text(encoding='utf-8', errors='replace'))
    sections.append(f"\n{dist.metadata['Name']} {dist.version}\n{dist.metadata.get('License-Expression') or dist.metadata.get('License') or ''}\n" + '\n'.join(texts))
node = root / 'apps/web/node_modules'
# The bundle and OCR use these top-level packages; nested manifests provide their notices too.
for path in sorted(node.rglob('package.json')):
    if '.cache' in path.parts:
        continue
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        continue
    sections.append(f"\n{data.get('name', path.parent.name)} {data.get('version', '')} - {data.get('license', '')}")
    for notice in path.parent.glob('*'):
        if notice.is_file() and notice.name.lower().startswith(('license', 'notice', 'copying')):
            sections.append(notice.read_text(encoding='utf-8', errors='replace'))
output.write_text('\n'.join(sections), encoding='utf-8')
