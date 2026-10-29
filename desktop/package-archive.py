"""Create a share-readable Windows ZIP and checksum, without personal data."""
import hashlib
from pathlib import Path
import sys
import zipfile

workspace = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(workspace) or output == workspace:
    raise SystemExit('Output must be inside the workspace.')
bundle = output / 'DubuTianxia'
if not (bundle / 'DubuTianxia.exe').is_file() or not (bundle / '_internal').is_dir():
    raise SystemExit('Complete application bundle is required.')
files = sorted(path for path in bundle.rglob('*') if path.is_file())
for path in files:
    relative = path.relative_to(bundle)
    if not path.resolve().is_relative_to(bundle.resolve()) or any(part.lower() in {'.data', 'node_modules', '.venv', 'credentials.json'} for part in relative.parts) or path.suffix.lower() in {'.pdf', '.db', '.sqlite', '.sqlite3', '.log', '.env'}:
        raise SystemExit(f'Unexpected private or external input: {relative}')
archive = output / 'DubuTianxia-Windows-x64.zip'
temporary = archive.with_suffix('.zip.tmp')
with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as target:
    for path in files:
        target.write(path, path.relative_to(output).as_posix())
temporary.replace(archive)
with archive.open('rb') as stream:
    checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
(output / 'SHA256.txt').write_text(f'{checksum}  {archive.name}\n', encoding='utf-8')
print(f'{len(files)} files, {archive.stat().st_size} bytes, SHA256 {checksum}')
