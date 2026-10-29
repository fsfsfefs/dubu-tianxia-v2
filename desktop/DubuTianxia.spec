from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules, copy_metadata

root = Path(SPECPATH).parent
node = root / 'apps/web/node_modules'
datas = [(str(root / 'apps/web/dist'), 'web')]
# Explicit OCR allowlist: no node_modules tree, private data or downloaded models.
for source, target in [('tesseract.js/dist/worker.min.js', 'ocr/tesseract.js/dist'),
                       ('@tesseract.js-data/chi_sim/4.0.0', 'ocr/@tesseract.js-data/chi_sim/4.0.0'),
                       ('@tesseract.js-data/eng/4.0.0', 'ocr/@tesseract.js-data/eng/4.0.0')]:
    datas.append((str(node / source), target))
for path in (node / 'tesseract.js-core').glob('*.wasm*'):
    datas.append((str(path), 'ocr/tesseract.js-core'))
binaries, hidden = [], ['keyring.backends.Windows', 'uvicorn.logging']
for package in ('webview', 'fastembed', 'onnxruntime', 'tokenizers'):
    d, b, h = collect_all(package)
    datas += d
    binaries += b
    hidden += h
hidden += collect_submodules('clr_loader')
datas += copy_metadata('keyring', recursive=True)
a = Analysis([str(root / 'desktop/launcher.py')], pathex=[str(root / 'apps/api')],
    binaries=binaries, datas=datas, hiddenimports=hidden,
    excludes=['PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'gi', 'pytest', 'tkinter'],
    noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='DubuTianxia',
    console=False, upx=False, version=str(root / 'desktop/version.txt'))
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='DubuTianxia')
