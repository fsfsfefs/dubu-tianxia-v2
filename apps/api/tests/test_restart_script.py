"""Windows restart ownership checks, without stopping or starting any service."""
import base64
import os
from pathlib import Path
import shutil
import subprocess
import pytest


@pytest.mark.skipif(os.name != "nt", reason="Windows process identity helper")
def test_relative_vite_requires_exact_working_directory_and_known_entry():
    root = Path(__file__).resolve().parents[3]
    powershell = shutil.which("powershell.exe")
    assert powershell
    code = r'''
$ErrorActionPreference='Stop'
$projectRoot=(Get-Location).Path
$webRoot=Join-Path $projectRoot 'apps\web'
. (Join-Path $projectRoot 'scripts\windows-process-directory.ps1')
$actual=[ReaderProcessDirectory]::GetWorkingDirectory($PID)
if ([IO.Path]::GetFullPath($actual).TrimEnd('\') -ine $projectRoot.TrimEnd('\')) { throw 'Current directory query failed' }
if ($null -ne [ReaderProcessDirectory]::GetWorkingDirectory(2147483647)) { throw 'Missing process must fail closed' }
$tokens=$null;$parseErrors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot 'restart-dev.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Restart script parse error' }
$definition=$tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-ProjectService'},$true)
Invoke-Expression $definition.Extent.Text
$script:fixture=[pscustomobject]@{CommandLine='node.exe node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174';ExecutablePath='C:\runtime\node.exe';ParentProcessId=0;CreationDate=[datetime]::Now}
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) if($Filter -eq "ProcessId=$PID"){return $script:fixture};return $null }
[Environment]::CurrentDirectory=$webRoot
if (-not (Test-ProjectService $PID 'web')) { throw 'Detached relative Vite was not recognized' }
$script:fixture.CommandLine='node.exe ".\node_modules\vite\bin\vite.js" --port 5174'
if (-not (Test-ProjectService $PID 'web')) { throw 'Quoted relative Vite was not recognized' }
[Environment]::CurrentDirectory=$projectRoot
if (Test-ProjectService $PID 'web') { throw 'Unrelated working directory was accepted' }
[Environment]::CurrentDirectory=$webRoot
$script:fixture.CommandLine='node.exe another-vite-script.js --port 5174'
if (Test-ProjectService $PID 'web') { throw 'Unrelated script was accepted' }
$script:fixture.CommandLine='node.exe node_modules/vite/bin/vite.js --port 5174'
$script:fixture.ExecutablePath='C:\runtime\other.exe'
if (Test-ProjectService $PID 'web') { throw 'Unrelated executable was accepted' }
Write-Output 'ownership checks passed'
'''
    encoded=base64.b64encode(code.encode("utf-16-le")).decode("ascii")
    result=subprocess.run([powershell,"-NoProfile","-ExecutionPolicy","Bypass","-EncodedCommand",encoded],cwd=root,capture_output=True,timeout=30)
    assert result.returncode==0, result.stderr.decode(errors="replace")
    assert b"ownership checks passed" in result.stdout
