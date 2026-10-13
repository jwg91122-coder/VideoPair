@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "DIST=%ROOT%dist"
set "TOOLS=%ROOT%.tools"
set "MODE=%~1"

rem Project-local Node.js fallback. No administrator access or PATH changes required.
set "NODE_BOOTSTRAP_VERSION=24.18.0"
set "NODE_ARCHIVE=node-v%NODE_BOOTSTRAP_VERSION%-win-x64.zip"
set "NODE_TOOLS_DIR=%TOOLS%"
set "NODE_PORTABLE_DIR=%TOOLS%\node-v%NODE_BOOTSTRAP_VERSION%-win-x64"
set "NODE_ZIP=%TOOLS%\%NODE_ARCHIVE%"
set "NODE_SUMS=%TOOLS%\SHASUMS256-v%NODE_BOOTSTRAP_VERSION%.txt"
set "NODE_DOWNLOAD_URL=https://nodejs.org/dist/v%NODE_BOOTSTRAP_VERSION%/%NODE_ARCHIVE%"
set "NODE_SHASUMS_URL=https://nodejs.org/dist/v%NODE_BOOTSTRAP_VERSION%/SHASUMS256.txt"

if /I "%MODE%"=="clean" (
  if exist "%DIST%" rmdir /S /Q "%DIST%"
  echo Build outputs cleaned: "%DIST%"
  exit /b 0
)

if /I "%MODE%"=="clean-all" (
  if exist "%DIST%" rmdir /S /Q "%DIST%"
  if exist "%ROOT%node_modules" rmdir /S /Q "%ROOT%node_modules"
  if exist "%TOOLS%" rmdir /S /Q "%TOOLS%"
  echo Build outputs, dependencies, and project-local tools cleaned.
  exit /b 0
)

pushd "%ROOT%"
if errorlevel 1 (
  echo ERROR: Could not enter project directory: "%ROOT%"
  exit /b 1
)

if not exist "%ROOT%package.json" (
  echo ERROR: package.json was not found in "%ROOT%".
  popd
  exit /b 1
)

call :configure_node
if errorlevel 1 (
  echo.
  echo ERROR: A compatible Node.js runtime could not be configured.
  echo Install an official Node.js LTS release and run build.bat again:
  echo   winget install --id OpenJS.NodeJS.LTS -e
  popd
  exit /b 1
)

for /f "delims=" %%V in ('node -p "process.versions.node"') do set "NODE_VERSION=%%V"
for /f "delims=" %%V in ('npm --version') do set "NPM_VERSION=%%V"
echo Using Node.js !NODE_VERSION! and npm !NPM_VERSION!

if /I "%MODE%"=="bootstrap" (
  echo Node.js is ready. Run build.bat to create the installer.
  popd
  exit /b 0
)

set "CSC_IDENTITY_AUTO_DISCOVERY=false"
set "npm_config_audit=false"
set "npm_config_fund=false"

if exist "%ROOT%package-lock.json" (
  echo Installing exact locked dependencies...
  call npm ci --no-audit --no-fund
) else (
  echo Installing dependencies and creating package-lock.json...
  call npm install --no-audit --no-fund
)
if errorlevel 1 (
  echo ERROR: Dependency installation failed.
  popd
  exit /b 1
)

echo Validating source files...
call npm run check
if errorlevel 1 (
  echo ERROR: Source validation failed.
  popd
  exit /b 1
)

if /I "%MODE%"=="dev" (
  echo Starting development build...
  call npm run dev
  set "RESULT=!ERRORLEVEL!"
  popd
  exit /b !RESULT!
)

if /I "%MODE%"=="pack" (
  echo Creating unpacked Windows x64 application...
  call npm run pack -- --win --x64
) else (
  echo Building Windows x64 NSIS installer...
  call npm run build -- --win nsis --x64
)

if errorlevel 1 (
  echo ERROR: Electron build failed.
  popd
  exit /b 1
)

echo.
echo Build complete: "%DIST%"
echo SHA-256 hashes:
for %%F in ("%DIST%\*.exe" "%DIST%\*.zip" "%DIST%\*.blockmap" "%DIST%\*.yml") do (
  if exist "%%~fF" (
    echo.
    certutil -hashfile "%%~fF" SHA256
  )
)

popd
exit /b 0


:configure_node
rem Prefer a compatible system installation.
where node >nul 2>nul
if not errorlevel 1 (
  node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);" >nul 2>nul
  if not errorlevel 1 (
    where npm >nul 2>nul
    if not errorlevel 1 exit /b 0
  )

  for /f "delims=" %%V in ('node -p "process.versions.node" 2^>nul') do set "FOUND_NODE_VERSION=%%V"
  if defined FOUND_NODE_VERSION (
    echo Found incompatible Node.js !FOUND_NODE_VERSION! in PATH; using the project-local runtime instead.
  ) else (
    echo The Node.js installation in PATH is unusable; using the project-local runtime instead.
  )
)

rem Reuse an already downloaded project-local runtime.
if exist "%NODE_PORTABLE_DIR%\node.exe" (
  set "PATH=%NODE_PORTABLE_DIR%;%PATH%"
  node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);" >nul 2>nul
  if not errorlevel 1 (
    where npm >nul 2>nul
    if not errorlevel 1 exit /b 0
  )
  echo Existing project-local Node.js runtime is invalid; downloading it again.
)

call :bootstrap_node
if errorlevel 1 exit /b 1

set "PATH=%NODE_PORTABLE_DIR%;%PATH%"
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);" >nul 2>nul
if errorlevel 1 exit /b 1

where npm >nul 2>nul
if errorlevel 1 exit /b 1

exit /b 0


:bootstrap_node
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: PowerShell is required to download the project-local Node.js runtime.
  exit /b 1
)

echo Node.js 22.12 or newer was not found.
echo Downloading official portable Node.js v%NODE_BOOTSTRAP_VERSION% for this project...
echo No administrator permission or permanent PATH change is required.

if not exist "%TOOLS%" mkdir "%TOOLS%"
if errorlevel 1 (
  echo ERROR: Could not create "%TOOLS%".
  exit /b 1
)

if exist "%NODE_PORTABLE_DIR%" rmdir /S /Q "%NODE_PORTABLE_DIR%"
if exist "%NODE_ZIP%" del /Q "%NODE_ZIP%"
if exist "%NODE_SUMS%" del /Q "%NODE_SUMS%"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri $env:NODE_DOWNLOAD_URL -OutFile $env:NODE_ZIP; Invoke-WebRequest -UseBasicParsing -Uri $env:NODE_SHASUMS_URL -OutFile $env:NODE_SUMS; $match=Select-String -LiteralPath $env:NODE_SUMS -Pattern ('  '+[regex]::Escape($env:NODE_ARCHIVE)+'$') | Select-Object -First 1; if (-not $match) { throw 'Node.js checksum entry was not found.' }; $expected=($match.Line -split '\s+')[0].ToUpperInvariant(); $actual=(Get-FileHash -LiteralPath $env:NODE_ZIP -Algorithm SHA256).Hash.ToUpperInvariant(); if ($actual -ne $expected) { throw ('Node.js checksum mismatch. Expected '+$expected+' but received '+$actual) }; Expand-Archive -LiteralPath $env:NODE_ZIP -DestinationPath $env:NODE_TOOLS_DIR -Force"
if errorlevel 1 (
  echo ERROR: Automatic Node.js download, verification, or extraction failed.
  if exist "%NODE_PORTABLE_DIR%" rmdir /S /Q "%NODE_PORTABLE_DIR%"
  exit /b 1
)

if not exist "%NODE_PORTABLE_DIR%\node.exe" (
  echo ERROR: Portable Node.js extraction did not produce node.exe.
  exit /b 1
)

del /Q "%NODE_ZIP%" >nul 2>nul
del /Q "%NODE_SUMS%" >nul 2>nul
echo Portable Node.js installed in "%NODE_PORTABLE_DIR%".
exit /b 0
