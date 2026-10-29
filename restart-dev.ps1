param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$apiRoot = Join-Path $projectRoot 'apps\api'
$webRoot = Join-Path $projectRoot 'apps\web'
$apiPython = Join-Path $apiRoot '.venv\Scripts\python.exe'
$viteScript = Join-Path $webRoot 'node_modules\vite\bin\vite.js'
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = $nodeCommand.Source
foreach ($file in @($apiPython, $viteScript, $nodePath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "缺少启动依赖：$file。请先安装项目依赖。"
    }
}
if ($ValidateOnly) {
    Write-Host '启动脚本与本地依赖检查通过（未停止或启动任何服务）。'
    exit 0
}

function Get-ListenerIds([int]$Port) {
    # Fail closed if port ownership cannot be inspected.
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $Port } |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-ProjectService([int]$ProcessId, [string]$Kind) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if (-not $process) { return $false }
    $command = [string]$process.CommandLine
    if ($Kind -eq 'api' -and $command -notmatch 'uvicorn\s+reader_next_api\.main:app') { return $false }
    if ($Kind -eq 'web' -and $command -notmatch '(?i)\bvite(?:\.js)?\b') { return $false }
    # Check a bounded parent chain: Windows venv launchers may use the base Python executable.
    for ($level = 0; $process -and $level -lt 5; $level++) {
        $command = ([string]$process.CommandLine).Replace('/', '\')
        $executable = ([string]$process.ExecutablePath).Replace('/', '\')
        if ($command.IndexOf($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $executable.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
        $parentId = [int]$process.ParentProcessId
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction Stop
        if ($parent -and $parent.CreationDate -gt $process.CreationDate) { return $false }
        $process = $parent
    }
    return $false
}

# Validate both ports before stopping anything; never terminate unrelated Python/Node programs.
$services = @(@{ Port = 8790; Kind = 'api' }, @{ Port = 5174; Kind = 'web' })
$toStop = @()
foreach ($service in $services) {
    foreach ($listenerId in @(Get-ListenerIds $service.Port)) {
        if (-not (Test-ProjectService $listenerId $service.Kind)) {
            throw "端口 $($service.Port) 被其他程序占用，未停止任何服务。请先检查该程序。"
        }
        $toStop += @{ Id = $listenerId; Kind = $service.Kind }
    }
}
Write-Host '正在重新启动读步天下…'
foreach ($entry in $toStop) {
    # Recheck ownership immediately before stopping to guard against PID reuse.
    if (-not (Test-ProjectService $entry.Id $entry.Kind)) { throw '服务进程已变化，请重试。' }
    $process = Get-Process -Id $entry.Id -ErrorAction Stop
    Stop-Process -Id $entry.Id -ErrorAction Stop
    if (-not $process.WaitForExit(10000)) { throw '旧服务尚未退出，请稍后重试。' }
}
foreach ($service in $services) {
    if (@(Get-ListenerIds $service.Port).Count) { throw "端口 $($service.Port) 尚未释放，请稍后重试。" }
}

$runFolder = Join-Path $projectRoot ('.tmp\restart-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runFolder -Force | Out-Null
$apiProcess = $null
$webProcess = $null
try {
    $apiProcess = Start-Process -FilePath $apiPython -WorkingDirectory $apiRoot -WindowStyle Hidden -PassThru `
        -ArgumentList @('-m', 'uvicorn', 'reader_next_api.main:app', '--app-dir', ('"' + $apiRoot + '"'), '--host', '127.0.0.1', '--port', '8790') `
        -RedirectStandardOutput (Join-Path $runFolder 'api.stdout.log') -RedirectStandardError (Join-Path $runFolder 'api.stderr.log')
    # Start Vite directly with an explicit root and strict port, avoiding stray npm/cmd parent windows.
    $webProcess = Start-Process -FilePath $nodePath -WorkingDirectory $webRoot -WindowStyle Hidden -PassThru `
        -ArgumentList @(('"' + $viteScript + '"'), ('"' + $webRoot + '"'), '--host', '127.0.0.1', '--port', '5174', '--strictPort') `
        -RedirectStandardOutput (Join-Path $runFolder 'web.stdout.log') -RedirectStandardError (Join-Path $runFolder 'web.stderr.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        if ($apiProcess.HasExited -or $webProcess.HasExited) { throw "服务启动失败，诊断日志：$runFolder" }
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:8790/api/health' -TimeoutSec 2
            $page = Invoke-WebRequest 'http://127.0.0.1:5174/' -UseBasicParsing -TimeoutSec 2
            if ($page.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "等待服务启动超时，诊断日志：$runFolder" }
    Start-Process 'http://127.0.0.1:5174/'
    Write-Host '读步天下已重新启动。未完成的总结可在任务中心重新执行。'
} catch {
    # Only clean up the process objects created by this invocation.
    foreach ($started in @($apiProcess, $webProcess)) {
        if ($started -and -not $started.HasExited) { $started.Kill() }
    }
    throw
}
