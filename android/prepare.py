"""Stage explicit Android resources. Never traverse .data or dependency trees."""
from pathlib import Path
import shutil
import zipfile
import os
import subprocess

root = Path(__file__).resolve().parents[1]
target = root / '.tmp/android-payload'
python = target / 'python/reader_next_api'
assets = target / 'assets'
python.mkdir(parents=True, exist_ok=True)
assets.mkdir(parents=True, exist_ok=True)
debug_key = root / '.tmp/android-signing/debug.keystore'
if not debug_key.is_file():
    debug_key.parent.mkdir(parents=True, exist_ok=True)
    tool = str(Path(os.environ['JAVA_HOME']) / 'bin' / ('keytool.exe' if os.name == 'nt' else 'keytool'))
    subprocess.run([tool, '-genkeypair', '-keystore', str(debug_key), '-storepass', 'android',
                    '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA',
                    '-validity', '10000', '-dname', 'CN=Android Debug'], check=True)
for source in (root / 'apps/api/reader_next_api').rglob('*.py'):
    if '__pycache__' in source.parts:
        continue
    output = python / source.relative_to(root / 'apps/api/reader_next_api')
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, output)
web = root / 'apps/web/dist'
if not (web / 'index.html').is_file():
    raise SystemExit('Build the web frontend first.')
node = root / 'apps/web/node_modules'
files = [(file, 'web/' + file.relative_to(web).as_posix()) for file in web.rglob('*') if file.is_file() and '.vite' not in file.parts]
files += [(node / 'tesseract.js/dist/worker.min.js', 'ocr/tesseract.js/dist/worker.min.js')]
files += [(file, 'ocr/tesseract.js-core/' + file.name) for file in (node / 'tesseract.js-core').glob('*.wasm*')]
for language in ('chi_sim', 'eng'):
    file = node / '@tesseract.js-data' / language / '4.0.0' / f'{language}.traineddata.gz'
    files.append((file, f'ocr/@tesseract.js-data/{language}/4.0.0/{file.name}'))
with zipfile.ZipFile(assets / 'offline.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for source, name in files:
        archive.write(source, name)
print(f'Android staged: {len(files)} offline assets and backend Python sources.')
