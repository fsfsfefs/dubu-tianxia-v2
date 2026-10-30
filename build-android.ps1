param([string]$JavaHome=$env:JAVA_HOME,[string]$SdkRoot=$env:ANDROID_HOME,[string]$GradleCommand='.tmp/android-tools/gradle/gradle-8.11.1/bin/gradle.bat')
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $JavaHome -or -not (Test-Path "$JavaHome/bin/java.exe")) { throw 'Set JAVA_HOME to JDK 17 or 21.' }
if (-not $SdkRoot) { $SdkRoot=Join-Path $PWD '.tmp/android-sdk' }
if (-not (Test-Path "$SdkRoot/platforms/android-35/android.jar")) { throw 'Install Android SDK platform 35 and build-tools 35.0.0 first.' }
$env:JAVA_HOME=$JavaHome
$env:ANDROID_HOME=$SdkRoot
$env:ANDROID_USER_HOME=Join-Path $PWD '.tmp/android-user'
$env:GRADLE_USER_HOME=Join-Path $PWD '.tmp/gradle-home'
$env:DUBU_BUILD_PYTHON=Join-Path $PWD 'apps/api/.venv/Scripts/python.exe'
$env:PYTHONUTF8='1'
$env:TEMP=Join-Path $PWD '.tmp/android-tools'
$env:TMP=$env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
$signing=Join-Path $PWD '.private/android-signing'
New-Item -ItemType Directory -Force $signing | Out-Null
$secret=Join-Path $signing 'password.txt'
$env:DUBU_SIGNING_STORE=Join-Path $signing 'release.p12'
if (-not (Test-Path $secret)) {
    if (Test-Path $env:DUBU_SIGNING_STORE) { throw 'Signing password is missing. Restore your signing backup.' }
    [guid]::NewGuid().ToString('N') | Set-Content -Encoding ascii $secret
}
$env:DUBU_SIGNING_PASSWORD=(Get-Content $secret -Raw).Trim()
if (-not (Test-Path $env:DUBU_SIGNING_STORE)) {
    & "$JavaHome/bin/keytool.exe" -genkeypair -keystore $env:DUBU_SIGNING_STORE -storetype PKCS12 -storepass:env DUBU_SIGNING_PASSWORD -keypass:env DUBU_SIGNING_PASSWORD -alias dubutianxia -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=DubuTianxia Android'
    if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed.' }
}
Push-Location apps/web
try {
    npm.cmd exec -- tsc -b
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript failed.' }
    npm.cmd exec -- vite build --mode android
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
    node tests/build-budget.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Build budget failed.' }
} finally { Pop-Location }
& $env:DUBU_BUILD_PYTHON android/prepare.py
if ($LASTEXITCODE -ne 0) { throw 'Asset staging failed.' }
& $GradleCommand -p apps/android :app:assembleRelease --console=plain
if ($LASTEXITCODE -ne 0) { throw 'APK build failed.' }
New-Item -ItemType Directory -Force dist/android | Out-Null
Copy-Item apps/android/app/build/outputs/apk/release/app-release.apk dist/android/DubuTianxia-tablet.apk -Force
& "$SdkRoot/build-tools/35.0.0/apksigner.bat" verify dist/android/DubuTianxia-tablet.apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
Get-FileHash dist/android/DubuTianxia-tablet.apk | Format-List | Out-File -Encoding utf8 dist/android/SHA256.txt
Remove-Item Env:DUBU_SIGNING_PASSWORD
