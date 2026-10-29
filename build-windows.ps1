param([switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$buildPython = Join-Path $PSScriptRoot '.tmp/desktop-venv/Scripts/python.exe'
$taskTemp = Join-Path $PSScriptRoot '.tmp/desktop-temp'
New-Item -ItemType Directory -Force -Path $taskTemp | Out-Null
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
$env:PIP_CACHE_DIR = Join-Path $PSScriptRoot '.tmp/pip-cache'
$env:PYINSTALLER_CONFIG_DIR = Join-Path $PSScriptRoot '.tmp/desktop-cache'
$env:PYTHONUTF8 = '1'
$env:HF_HOME = Join-Path $PSScriptRoot '.tmp/desktop-hf-cache'
if (-not $SkipInstall) {
    if (-not (Test-Path -LiteralPath $buildPython)) {
        py -3.12 -m venv .tmp/desktop-venv
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create Python 3.12 build environment.' }
    }
    & $buildPython -m pip install -r desktop/requirements-win-py312.lock
    if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed.' }
    & $buildPython -m pip install --no-deps --no-build-isolation -e apps/api
    if ($LASTEXITCODE -ne 0) { throw 'API installation failed.' }
    Push-Location apps/web
    try { npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' } } finally { Pop-Location }
}
& $buildPython scripts/check-desktop-lock.py
if ($LASTEXITCODE -ne 0) { throw 'Python lock check failed.' }
Push-Location apps/web
try { npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' } } finally { Pop-Location }
& $buildPython -m PyInstaller --noconfirm --clean --distpath dist/windows --workpath .tmp/desktop-build desktop/DubuTianxia.spec
if ($LASTEXITCODE -ne 0) { throw 'EXE packaging failed.' }
Copy-Item -LiteralPath docs/windows-desktop.md -Destination dist/windows/DubuTianxia/README.zh-CN.md
& $buildPython desktop/write-notices.py
if ($LASTEXITCODE -ne 0) { throw 'License inventory failed.' }
Compress-Archive -LiteralPath dist/windows/DubuTianxia -DestinationPath dist/windows/DubuTianxia-Windows-x64.zip -Force
Get-FileHash -Algorithm SHA256 -LiteralPath dist/windows/DubuTianxia-Windows-x64.zip |
    Format-List | Out-File -Encoding utf8 dist/windows/SHA256.txt
Write-Host 'Ready: dist/windows/DubuTianxia/DubuTianxia.exe'
