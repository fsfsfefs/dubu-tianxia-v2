param([switch]$SkipInstall, [string]$OutputDirectory = 'dist/windows')
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
$outputRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $OutputDirectory))
$workspacePrefix = $PSScriptRoot.TrimEnd('\') + '\'
if (-not $outputRoot.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay inside this workspace.' }
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
& $buildPython -m PyInstaller --noconfirm --distpath $outputRoot --workpath .tmp/desktop-build desktop/DubuTianxia.spec
if ($LASTEXITCODE -ne 0) { throw 'EXE packaging failed.' }
Copy-Item -LiteralPath docs/windows-desktop.md -Destination (Join-Path $outputRoot 'DubuTianxia/README.zh-CN.md')
& $buildPython desktop/write-notices.py $outputRoot
if ($LASTEXITCODE -ne 0) { throw 'License inventory failed.' }
& $buildPython desktop/package-archive.py $outputRoot
if ($LASTEXITCODE -ne 0) { throw 'ZIP packaging failed.' }
Write-Host "Ready: $outputRoot/DubuTianxia/DubuTianxia.exe"
