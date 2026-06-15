param(
  [switch]$SkipSelfTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Log([string]$Message) {
  Write-Host "[bundle-hermes-windows] $Message"
}

function Fail([string]$Message) {
  throw "[bundle-hermes-windows] $Message"
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$FilePath exited with code $LASTEXITCODE."
  }
}

function Resolve-Python {
  $candidates = @(
    @{ Exe = "py"; Args = @("-3.11") },
    @{ Exe = "py"; Args = @("-3.12") },
    @{ Exe = "py"; Args = @("-3.13") },
    @{ Exe = "python"; Args = @() },
    @{ Exe = "python3"; Args = @() }
  )

  foreach ($candidate in $candidates) {
    try {
      $args = @($candidate.Args + @(
        "-c",
        "import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] < (3, 14) else 1)"
      ))
      & $candidate.Exe @args
      if ($LASTEXITCODE -eq 0) {
        return $candidate
      }
    } catch {
    }
  }

  Fail "Python 3.11, 3.12, or 3.13 is required to install uv for the Windows Hermes bundle."
}

function Ensure-Uv {
  $uv = Get-Command "uv.exe" -ErrorAction SilentlyContinue
  if ($null -ne $uv) {
    return @{ Exe = $uv.Source; Args = @() }
  }

  $python = Resolve-Python
  Log "uv not found; installing uv 0.11.15 through Python"
  Invoke-Native $python.Exe @($python.Args + @("-m", "pip", "install", "--user", "uv==0.11.15"))

  $uv = Get-Command "uv.exe" -ErrorAction SilentlyContinue
  if ($null -ne $uv) {
    return @{ Exe = $uv.Source; Args = @() }
  }

  $userScriptProbe = @'
import os
import site
import sysconfig

paths = []
for scheme in ("nt_user", "posix_user", "osx_framework_user"):
    try:
        path = sysconfig.get_path("scripts", scheme=scheme)
    except Exception:
        path = None
    if path:
        paths.append(path)
paths.append(os.path.join(site.USER_BASE, "Scripts"))

seen = set()
print(os.pathsep.join(path for path in paths if not (path in seen or seen.add(path))))
'@
  $candidateDirs = (& $python.Exe @($python.Args + @("-c", $userScriptProbe))).Trim() -split [IO.Path]::PathSeparator
  foreach ($dir in $candidateDirs) {
    if ([string]::IsNullOrWhiteSpace($dir)) {
      continue
    }
    $candidateUv = Join-Path $dir "uv.exe"
    if (Test-Path -LiteralPath $candidateUv -PathType Leaf) {
      return @{ Exe = $candidateUv; Args = @() }
    }
  }

  $userBase = (& $python.Exe @($python.Args + @("-c", "import site; print(site.USER_BASE)"))).Trim()
  $foundUv = Get-ChildItem -Path $userBase -Filter "uv.exe" -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $foundUv) {
    return @{ Exe = $foundUv.FullName; Args = @() }
  }

  Fail "uv installed but uv.exe was not found on PATH or under $userBase."
}

function Invoke-Uv {
  param(
    [Parameter(Mandatory = $true)]$Uv,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [hashtable]$ExtraEnv = @{},
    [string]$WorkingDirectory = ""
  )

  $saved = @{}
  foreach ($key in $ExtraEnv.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$ExtraEnv[$key], "Process")
  }

  $previousLocation = $null
  try {
    if (![string]::IsNullOrWhiteSpace($WorkingDirectory)) {
      $previousLocation = Get-Location
      Set-Location $WorkingDirectory
    }
    Invoke-Native $Uv.Exe @($Uv.Args + $Arguments)
  } finally {
    if ($null -ne $previousLocation) {
      Set-Location $previousLocation
    }
    foreach ($key in $ExtraEnv.Keys) {
      [Environment]::SetEnvironmentVariable($key, $saved[$key], "Process")
    }
  }
}

function Read-Pin([string]$BridgePath, [string]$Name) {
  $lines = Get-Content -Path $BridgePath
  $declaration = "const $Name" + ": &str ="
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index].Contains($declaration)) {
      for ($inner = $index; $inner -lt [Math]::Min($index + 3, $lines.Count); $inner++) {
        if ($lines[$inner] -match '"([^"]+)"') {
          return $Matches[1]
        }
      }
    }
  }
  Fail "could not read $Name from $BridgePath."
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$outParent = Join-Path $root ".tauri-hermes"
$out = Join-Path $outParent "hermes"
$work = Join-Path $outParent "work-windows"
$bridgeRs = Join-Path $root "src-tauri\src\hermes_bridge.rs"

$commit = Read-Pin $bridgeRs "HERMES_AGENT_INSTALL_COMMIT"
$tarballUrl = Read-Pin $bridgeRs "HERMES_SOURCE_TARBALL_URL"
$tarballSha256 = (Read-Pin $bridgeRs "HERMES_SOURCE_TARBALL_SHA256").ToLowerInvariant()
Log "pin: $commit"

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $out, $work
New-Item -ItemType Directory -Force -Path $out, $work | Out-Null

$uv = Ensure-Uv
Log "uv: $(& $uv.Exe @($uv.Args + @('--version')))"

Log "downloading hermes-agent@$commit"
$archive = Join-Path $work "hermes-agent.tar.gz"
Invoke-WebRequest -Uri $tarballUrl -OutFile $archive
$actualSha256 = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
if ($actualSha256 -ne $tarballSha256) {
  Fail "tarball sha256 mismatch: expected $tarballSha256, got $actualSha256."
}

Invoke-Native "tar" @("-xzf", $archive, "-C", $work)
$unpacked = Get-ChildItem -Path $work -Directory |
  Where-Object { $_.Name -like "hermes-agent-*" } |
  Select-Object -First 1
if ($null -eq $unpacked) {
  Fail "tarball did not contain a hermes-agent directory."
}
Move-Item -Path $unpacked.FullName -Destination (Join-Path $out "hermes-agent")
$agentDir = Join-Path $out "hermes-agent"

foreach ($prune in @("tests", "website", "apps", ".github")) {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $agentDir $prune)
}

$licenseFiles = Get-ChildItem -Path $agentDir -Recurse -File |
  Where-Object { $_.Name -match '^(LICENSE(\..*)?|NOTICE(\..*)?|COPYING(\..*)?)$' } |
  Sort-Object FullName
if (!(Test-Path -LiteralPath (Join-Path $agentDir "LICENSE") -PathType Leaf)) {
  Fail "hermes-agent LICENSE missing from pinned tarball."
}
if (($licenseFiles | Measure-Object).Count -eq 0) {
  Fail "no Hermes license or notice files found."
}

$noticesDir = Join-Path $out "third_party_notices"
New-Item -ItemType Directory -Force -Path $noticesDir | Out-Null
$noticeLines = @(
  "Third-party notices for bundled Hermes runtime",
  "",
  "Hermes Agent source: $tarballUrl",
  "Hermes Agent commit: $commit",
  "",
  "Preserved upstream license and notice files:"
)
foreach ($file in $licenseFiles) {
  $relative = [IO.Path]::GetRelativePath($agentDir, $file.FullName).Replace("\", "/")
  $noticeLines += "- hermes-agent/$relative"
}
[IO.File]::WriteAllLines((Join-Path $noticesDir "THIRD_PARTY_NOTICES.txt"), $noticeLines, [Text.UTF8Encoding]::new($false))

if ($null -eq (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) {
  Fail "npm is required to prebuild the Hermes dashboard web UI."
}
Log "prebuilding dashboard web UI"
Push-Location (Join-Path $agentDir "web")
try {
  Invoke-Native "npm.cmd" @("ci", "--no-audit", "--no-fund")
  Invoke-Native "npm.cmd" @("run", "build")
} finally {
  Pop-Location
}
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
  (Join-Path $agentDir "node_modules"),
  (Join-Path $agentDir "web\node_modules"),
  (Join-Path $agentDir "ui-tui\node_modules")
if (!(Test-Path -LiteralPath (Join-Path $agentDir "hermes_cli\web_dist\index.html") -PathType Leaf)) {
  Fail "web_dist missing after build."
}

Log "installing standalone CPython 3.11"
Invoke-Uv $uv @("python", "install", "3.11") @{
  UV_PYTHON_INSTALL_DIR = (Join-Path $out "python")
  UV_PYTHON_INSTALL_BIN = "0"
  UV_NO_CONFIG = "1"
}

$pythonRoot = Join-Path $out "python"
$pythonInstall = Get-ChildItem -Path $pythonRoot -Directory |
  Where-Object { $_.Name -like "cpython-3.11*" } |
  Select-Object -First 1
if ($null -eq $pythonInstall) {
  Fail "uv did not install a cpython-3.11 runtime."
}
$currentPythonRoot = Join-Path $pythonRoot "current"
if (($pythonInstall.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  Log "copying CPython runtime out of uv reparse point"
  New-Item -ItemType Directory -Force -Path $currentPythonRoot | Out-Null
  Copy-Item -Recurse -Force -Path (Join-Path $pythonInstall.FullName "*") -Destination $currentPythonRoot
  Remove-Item -Recurse -Force -LiteralPath $pythonInstall.FullName
} else {
  Move-Item -Path $pythonInstall.FullName -Destination $currentPythonRoot
}
if (((Get-Item -LiteralPath $currentPythonRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  Fail "bundled python runtime is still a reparse point: $currentPythonRoot"
}
$py = Join-Path $pythonRoot "current\python.exe"
if (!(Test-Path -LiteralPath $py -PathType Leaf)) {
  Fail "bundled python missing at $py."
}

Log "installing python deps"
$venvDir = Join-Path $agentDir "venv"
$syncSucceeded = $true
try {
  Invoke-Uv $uv @("sync", "--extra", "all", "--locked", "--python", $py) @{
    UV_PROJECT_ENVIRONMENT = $venvDir
    UV_NO_CONFIG = "1"
    UV_PYTHON_INSTALL_DIR = $pythonRoot
  } $agentDir
} catch {
  $syncSucceeded = $false
  Log "lockfile sync unavailable; falling back to: uv pip install -e .[all]"
}
if (!$syncSucceeded) {
  Invoke-Uv $uv @("pip", "install", "-p", $venvDir, "-e", ".[all]") @{
    UV_NO_CONFIG = "1"
    UV_PYTHON_INSTALL_DIR = $pythonRoot
  } $agentDir
}

$venvSp = Join-Path $venvDir "Lib\site-packages"
$baseSp = Join-Path $pythonRoot "current\Lib\site-packages"
foreach ($path in @($venvSp, $baseSp)) {
  if (!(Test-Path -LiteralPath $path -PathType Container)) {
    Fail "site-packages directory missing: $path"
  }
}

Get-ChildItem -Path $venvSp -Force |
  Where-Object { $_.Name -like "*editable*" -or $_.Name -like "_hermes*" } |
  Remove-Item -Recurse -Force
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $venvDir "Scripts")

[IO.File]::WriteAllLines(
  (Join-Path $baseSp "hermes-bundle.pth"),
  @(
    "../../../../hermes-agent",
    "../../../../hermes-agent/venv/Lib/site-packages"
  ),
  [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText(
  (Join-Path $baseSp "sitecustomize.py"),
  "import sys`n`nsys.dont_write_bytecode = True`n",
  [Text.UTF8Encoding]::new($false)
)

Log "precompiling bytecode"
try {
  Invoke-Native $py @("-m", "compileall", "-q", "--invalidation-mode", "checked-hash", $agentDir, $baseSp)
} catch {
  Log "bytecode precompile skipped some files"
}

$links = Get-ChildItem -Path $out -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
  Select-Object -First 5
if (($links | Measure-Object).Count -gt 0) {
  $linkList = ($links | ForEach-Object { $_.FullName }) -join "`n"
  Fail "bundle still contains reparse points:`n$linkList"
}

Log "building relocatable launcher"
$binDir = Join-Path $out "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$launcherSource = Join-Path $work "hermes-launcher.rs"
@'
use std::{
    env,
    path::PathBuf,
    process::{exit, Command},
};

fn main() {
    let exe = env::current_exe().unwrap_or_else(|error| {
        eprintln!("Could not resolve launcher path: {error}");
        exit(1);
    });
    let root = exe
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            eprintln!("Could not resolve Hermes bundle root.");
            exit(1);
        });
    let python = root.join("python").join("current").join("python.exe");
    let mut cmd = Command::new(python);
    cmd.arg("-m")
        .arg("hermes_cli.main")
        .args(env::args_os().skip(1))
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONNOUSERSITE", "1");
    match cmd.status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("Could not start bundled Hermes Python: {error}");
            exit(1);
        }
    }
}
'@ | Set-Content -Path $launcherSource -Encoding utf8
Invoke-Native "rustc" @($launcherSource, "-O", "-o", (Join-Path $binDir "hermes.exe"))

[IO.File]::WriteAllText((Join-Path $out "PIN"), "$commit`n", [Text.UTF8Encoding]::new($false))

if (!$SkipSelfTest) {
  Log "self-test: running the launcher from a relocated copy"
  $selftestRoot = Join-Path ([IO.Path]::GetTempPath()) ("hermes-bundle-" + [guid]::NewGuid().ToString("N"))
  try {
    $selftest = Join-Path $selftestRoot "re located"
    New-Item -ItemType Directory -Force -Path $selftest | Out-Null
    Copy-Item -Recurse -Path $out -Destination (Join-Path $selftest "hermes")
    $testHome = Join-Path $selftestRoot "hermes-home"
    New-Item -ItemType Directory -Force -Path $testHome | Out-Null
    $previousHome = $env:HERMES_HOME
    try {
      $env:HERMES_HOME = $testHome
      Invoke-Native (Join-Path $selftest "hermes\bin\hermes.exe") @("--version")
      Invoke-Native (Join-Path $selftest "hermes\python\current\python.exe") @("-c", "import hermes_cli.main")
    } finally {
      $env:HERMES_HOME = $previousHome
    }
  } finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $selftestRoot
  }
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
$size = (Get-ChildItem -Path $out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Log ("bundle size: {0:N1} MB" -f ($size / 1MB))
Log "done: $out"
