[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$SevenZipPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 7) { throw "PowerShell 7 or newer is required." }
if (
  -not $IsWindows -or
  [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64 -or
  [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64
) {
  throw "Native x64 Windows is required."
}
$nodeVersionOutput = & node --version
$nodeVersionExit = $LASTEXITCODE
$nodeVersion = "$nodeVersionOutput".Trim()
if ($nodeVersionExit -ne 0 -or $nodeVersion -notmatch '^v24\.') { throw "Node 24 is required; got '$nodeVersion'." }
$nodeHostOutput = & node -p "process.platform + ':' + process.arch"
$nodeHostExit = $LASTEXITCODE
$nodeHost = "$nodeHostOutput".Trim()
if ($nodeHostExit -ne 0 -or $nodeHost -ne "win32:x64") { throw "Native x64 Node 24 is required; got '$nodeHost'." }

$installer = Get-Item -LiteralPath $InstallerPath
if ($installer.Length -le 0) { throw "Installer is empty: $($installer.FullName)" }

if (-not $SevenZipPath) {
  $command = Get-Command 7z.exe -ErrorAction SilentlyContinue
  if ($command) { $SevenZipPath = $command.Source }
  elseif ($env:ProgramFiles) { $SevenZipPath = Join-Path $env:ProgramFiles "7-Zip\7z.exe" }
}
if (-not $SevenZipPath -or -not (Test-Path -LiteralPath $SevenZipPath -PathType Leaf)) {
  throw "A usable 7-Zip executable is required."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("Clovy Windows payload " + [guid]::NewGuid())
try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $installerRoot = Join-Path $tempRoot "installer contents"
  New-Item -ItemType Directory -Path $installerRoot | Out-Null
  & $SevenZipPath x "-o$installerRoot" -y -- $installer.FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7-Zip could not extract the NSIS installer." }

  $archives = @(Get-ChildItem -LiteralPath $installerRoot -Recurse -File -Filter "app-*.7z")
  $payloadRoots = @($installerRoot)
  if ($archives.Count -gt 0) {
    for ($index = 0; $index -lt $archives.Count; $index++) {
      $archiveRoot = Join-Path $tempRoot ("nested payload {0}" -f $index)
      New-Item -ItemType Directory -Path $archiveRoot | Out-Null
      & $SevenZipPath x "-o$archiveRoot" -y -- $archives[$index].FullName | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "7-Zip could not extract $($archives[$index].FullName)." }
      $payloadRoots += $archiveRoot
    }
  }

  $items = @($payloadRoots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse })
  $files = @($items | Where-Object { -not $_.PSIsContainer })
  function Require-One([string]$Name) {
    $matches = @($files | Where-Object { $_.Name -ieq $Name })
    if ($matches.Count -ne 1) { throw "Expected exactly one $Name in the final payload; found $($matches.Count)." }
    if ($matches[0].Length -le 0) { throw "Payload file is empty: $($matches[0].FullName)" }
    return $matches[0]
  }

  $app = Require-One "os-june.exe"
  # The MSVC target statically links WebView2Loader; only GNU builds ship its DLL.
  $runtime = Require-One "clovy-agent-runtime.exe"
  $checksum = Require-One "clovy-agent-runtime.exe.sha256"
  $helper = Require-One "june-dictation-helper.exe"
  if ($runtime.DirectoryName -ne $checksum.DirectoryName -or $runtime.DirectoryName -ne $helper.DirectoryName) {
    throw "Runtime, checksum, and dictation helper are not adjacent in the payload."
  }
  $nativeBin = $runtime.DirectoryName.Replace('\', '/').ToLowerInvariant()
  if (-not $nativeBin.EndsWith('/native/bin')) { throw "Native helpers are not under native/bin." }

  foreach ($item in $items) {
    $relative = $item.FullName.Replace('\', '/').ToLowerInvariant()
    if ($relative.Contains('/native/hermes/') -or $relative.EndsWith('/native/hermes') -or
        $item.Name -ieq 'python.exe' -or $item.Extension -ieq '.pyd' -or
        $relative.Contains('hermes-agent')) {
      throw "Legacy Hermes or Python payload found: $($item.FullName)"
    }
  }

  foreach ($unsignedFile in @($installer, $app, $helper)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $unsignedFile.FullName
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
      throw "Expected an unsigned file, but Authenticode status is $($signature.Status): $($unsignedFile.FullName)"
    }
  }
  # postject can retain invalid signature metadata from the Node executable.
  # It must never retain a valid publisher signature after SEA injection.
  $runtimeSignature = Get-AuthenticodeSignature -LiteralPath $runtime.FullName
  if ($runtimeSignature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Expected an unsigned agent runtime, but its Authenticode signature is valid: $($runtime.FullName)"
  }

  $repoRoot = Split-Path -Parent $PSScriptRoot
  & node (Join-Path $repoRoot "scripts/build-agent-runtime.mjs") --verify $runtime.FullName
  if ($LASTEXITCODE -ne 0) { throw "Extracted agent runtime verification failed." }
  Write-Host "Verified unsigned Windows installer payload: $($installer.FullName)"
}
finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
