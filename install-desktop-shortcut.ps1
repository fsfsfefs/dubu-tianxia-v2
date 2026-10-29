$ErrorActionPreference = 'Stop'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath '重新启动读步天下第二版.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    throw "桌面已存在同名快捷方式：$shortcutPath。请先核对原快捷方式，未覆盖。"
}
$shell = New-Object -ComObject WScript.Shell
$stageFolder = Join-Path $PSScriptRoot '.tmp'
New-Item -ItemType Directory -Path $stageFolder -Force | Out-Null
$stagePath = Join-Path $stageFolder ([guid]::NewGuid().ToString('N') + '.lnk')
$shortcut = $shell.CreateShortcut($stagePath)
$shortcut.TargetPath = Join-Path $PSScriptRoot 'restart-dev.cmd'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = '核对并重新启动读步天下第二版前后端，保留本地学习数据'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,167"
$shortcut.WindowStyle = 1
try {
    $shortcut.Save()
    # Copy without overwrite so an existing desktop entry is never replaced.
    [IO.File]::Copy($stagePath, $shortcutPath, $false)
} finally {
    if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath }
}
if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw '桌面快捷方式创建失败。' }
Write-Host "已创建：$shortcutPath"
