[CmdletBinding()]
param([string]$OutputDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot "artifacts\windows-unsigned" }
elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory = Join-Path $repoRoot $OutputDirectory }
$callerLocation = Get-Location
$hadPrebuilt = Test-Path Env:CLOVY_AGENT_RUNTIME_PREBUILT
$previousPrebuilt = $env:CLOVY_AGENT_RUNTIME_PREBUILT
$hadRuntimeTarget = Test-Path Env:CLOVY_AGENT_RUNTIME_TARGET
$previousRuntimeTarget = $env:CLOVY_AGENT_RUNTIME_TARGET
$previousPath = $env:PATH
$mutexPath = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd([char[]]"\/").ToUpperInvariant()
$mutexBytes = [System.Text.Encoding]::UTF8.GetBytes($mutexPath)
$mutexHasher = [System.Security.Cryptography.SHA256]::Create()
try { $mutexHash = [Convert]::ToHexString($mutexHasher.ComputeHash($mutexBytes)) }
finally { $mutexHasher.Dispose() }
$buildMutex = [System.Threading.Mutex]::new($false, "Local\ClovyWindowsBuild-$mutexHash")
$hasBuildMutex = $false

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "Required tool is unavailable: $Name" }
}

try {
  try { $hasBuildMutex = $buildMutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $hasBuildMutex = $true }
  if (-not $hasBuildMutex) { throw "Another Windows build is active against this repository." }
  if ($PSVersionTable.PSVersion.Major -lt 7) { throw "PowerShell 7 or newer is required." }
  if (
    -not $IsWindows -or
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64 -or
    [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64
  ) { throw "Native x64 Windows is required." }
  foreach ($tool in @("node", "pnpm", "rustc", "cargo")) { Require-Command $tool }
  $nodeVersionOutput = & node --version
  $nodeVersionExit = $LASTEXITCODE
  $nodeVersion = "$nodeVersionOutput".Trim()
  if ($nodeVersionExit -ne 0 -or $nodeVersion -notmatch '^v24\.') { throw "Node 24 is required; got '$nodeVersion'." }
  $nodeHostOutput = & node -p "process.platform + ':' + process.arch"
  $nodeHostExit = $LASTEXITCODE
  $nodeHost = "$nodeHostOutput".Trim()
  if ($nodeHostExit -ne 0 -or $nodeHost -ne "win32:x64") { throw "Native x64 Node 24 is required; got '$nodeHost'." }
  $rustDetails = & rustc -vV
  $rustExit = $LASTEXITCODE
  if ($rustExit -ne 0 -or ($rustDetails -join "`n") -notmatch '(?m)^host: x86_64-pc-windows-msvc$') {
    throw "The x86_64-pc-windows-msvc Rust host is required."
  }
  $cargoVersion = & cargo --version
  if ($LASTEXITCODE -ne 0 -or "$cargoVersion" -notmatch '^cargo ') { throw "cargo is not usable." }
  $targetTriple = "x86_64-pc-windows-msvc"
  $targetLibDirectory = & rustc --print target-libdir --target $targetTriple
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath "$targetLibDirectory" -PathType Container)) {
    throw "The $targetTriple Rust target is required."
  }
  if (-not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)) {
    throw "Unsigned Windows builds require WINDOWS_CERTIFICATE_PASSWORD to be unset."
  }
  $makensisCommand = Get-Command makensis.exe -ErrorAction SilentlyContinue
  $makensisCandidates = @()
  if (${env:ProgramFiles(x86)}) { $makensisCandidates += Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe" }
  if ($env:ProgramFiles) { $makensisCandidates += Join-Path $env:ProgramFiles "NSIS\makensis.exe" }
  $makensisPath = if ($makensisCommand) {
    $makensisCommand.Source
  } else {
    $makensisCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  }
  if (-not $makensisPath) { throw "A usable NSIS makensis.exe is required." }
  $env:PATH = "$(Split-Path -Parent $makensisPath);$env:PATH"
  $sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
  $sevenZipPath = if ($sevenZipCommand) { $sevenZipCommand.Source } else { Join-Path $env:ProgramFiles "7-Zip\7z.exe" }
  if (-not (Test-Path -LiteralPath $sevenZipPath -PathType Leaf)) { throw "A usable 7-Zip executable is required." }

  Set-Location -LiteralPath $repoRoot
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  Get-ChildItem -LiteralPath $OutputDirectory -File -Filter "*-setup.exe" | Remove-Item -Force
  $cargoMetadataOutput = & cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1
  if ($LASTEXITCODE -ne 0) { throw "Could not resolve Cargo's target directory." }
  $cargoTargetDirectory = ("$cargoMetadataOutput" | ConvertFrom-Json).target_directory
  if ([string]::IsNullOrWhiteSpace($cargoTargetDirectory)) { throw "Cargo metadata did not report a target directory." }
  & pnpm agent-runtime:build
  if ($LASTEXITCODE -ne 0) { throw "Agent runtime TypeScript build failed." }
  Remove-Item Env:CLOVY_AGENT_RUNTIME_PREBUILT -ErrorAction SilentlyContinue
  & node scripts/build-agent-runtime.mjs --target windows
  if ($LASTEXITCODE -ne 0) { throw "Windows agent runtime SEA build failed." }

  $releaseDirectory = Join-Path $cargoTargetDirectory "$targetTriple\release"
  $nsisDirectory = Join-Path $releaseDirectory "bundle\nsis"
  if (Test-Path -LiteralPath $nsisDirectory -PathType Container) {
    Get-ChildItem -LiteralPath $nsisDirectory -File -Filter "*-setup.exe" | Remove-Item -Force
  }
  $appExecutable = Join-Path $releaseDirectory "os-june.exe"
  Remove-Item -LiteralPath $appExecutable -Force -ErrorAction SilentlyContinue
  $env:CLOVY_AGENT_RUNTIME_PREBUILT = "1"
  $env:CLOVY_AGENT_RUNTIME_TARGET = "windows"
  & node scripts/tauri-build.mjs --target $targetTriple --no-sign
  if ($LASTEXITCODE -ne 0) { throw "Unsigned Tauri release build failed." }
  if ($hadPrebuilt) { $env:CLOVY_AGENT_RUNTIME_PREBUILT = $previousPrebuilt } else { Remove-Item Env:CLOVY_AGENT_RUNTIME_PREBUILT }
  if ($hadRuntimeTarget) { $env:CLOVY_AGENT_RUNTIME_TARGET = $previousRuntimeTarget } else { Remove-Item Env:CLOVY_AGENT_RUNTIME_TARGET }

  $installers = @(Get-ChildItem -LiteralPath $nsisDirectory -File -Filter "*-setup.exe")
  if ($installers.Count -ne 1) { throw "Expected exactly one release NSIS installer; found $($installers.Count)." }
  if ($installers[0].Length -le 0) { throw "Release NSIS installer is empty." }

  $stagedPath = Join-Path $OutputDirectory $installers[0].Name
  Copy-Item -LiteralPath $installers[0].FullName -Destination $stagedPath -Force
  try {
    & (Join-Path $PSScriptRoot "verify-windows-artifacts.ps1") -InstallerPath $stagedPath -SevenZipPath $sevenZipPath
    if ($LASTEXITCODE -ne 0) { throw "Staged installer verification failed." }
  }
  catch {
    Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
    throw
  }
  Write-Host "Unsigned Windows installer: $stagedPath"
}
finally {
  try {
    $env:PATH = $previousPath
    if ($hadPrebuilt) { $env:CLOVY_AGENT_RUNTIME_PREBUILT = $previousPrebuilt }
    else { Remove-Item Env:CLOVY_AGENT_RUNTIME_PREBUILT -ErrorAction SilentlyContinue }
    if ($hadRuntimeTarget) { $env:CLOVY_AGENT_RUNTIME_TARGET = $previousRuntimeTarget }
    else { Remove-Item Env:CLOVY_AGENT_RUNTIME_TARGET -ErrorAction SilentlyContinue }
    Set-Location -LiteralPath $callerLocation
  }
  finally {
    if ($hasBuildMutex) { $buildMutex.ReleaseMutex() }
    $buildMutex.Dispose()
  }
}
