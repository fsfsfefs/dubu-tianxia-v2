"""Fail early if the supported Windows/Python environment drifts from the lock."""
import importlib.metadata as metadata
import struct
import sys
from pathlib import Path

if sys.platform != 'win32' or sys.version_info[:2] != (3, 12) or struct.calcsize('P') != 8:
    raise SystemExit('This lock supports Windows x64 / CPython 3.12 only.')
lock = Path(__file__).resolve().parents[1] / 'apps/api/requirements-win-py312.lock'
count = 0
for line in lock.read_text(encoding='utf-8').splitlines():
    if not line.strip() or line.startswith('#'): continue
    name, expected = line.split('==')
    actual = metadata.version(name)
    if actual != expected: raise SystemExit(f'{name}: installed {actual}, expected {expected}')
    count += 1
print(f'Python {sys.version.split()[0]} / Windows x64: {count} dependency pins verified.')
