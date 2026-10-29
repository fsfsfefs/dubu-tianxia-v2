import importlib.metadata as metadata
from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
runpy.run_path(str(root / 'scripts/check-python-lock.py'))
count = 0
for line in (root / 'desktop/requirements-win-py312.lock').read_text(encoding='utf-8').splitlines():
    if not line or line.startswith(('#', '-')):
        continue
    name, expected = line.split('==')
    actual = metadata.version(name)
    if actual != expected:
        raise SystemExit(f'{name}: installed {actual}, expected {expected}')
    count += 1
print(f'{count} desktop dependency pins verified.')
