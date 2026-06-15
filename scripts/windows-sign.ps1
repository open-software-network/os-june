param(
  [Parameter(Mandatory = $true)]
  [string]$TargetPath
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  throw "[windows-sign] $Message"
}

function Resolve-RequiredFile([string]$Path, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    Fail "$Name is required."
  }
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    Fail "$Name does not point to a readable file: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).ProviderPath
}

function Find-SignTool {
  $configured = $env:WINDOWS_SIGNTOOL_PATH
  if (![string]::IsNullOrWhiteSpace($configured)) {
    return Resolve-RequiredFile $configured "WINDOWS_SIGNTOOL_PATH"
  }

  $onPath = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
  if ($null -ne $onPath) {
    return $onPath.Source
  }

  $programFilesX86 = ${env:ProgramFiles(x86)}
  if (![string]::IsNullOrWhiteSpace($programFilesX86)) {
    $kitsRoot = Join-Path $programFilesX86 "Windows Kits\10\bin"
    if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
      $candidates = Get-ChildItem -Path $kitsRoot -Filter "signtool.exe" -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object `
          @{ Expression = { if ($_.FullName -match "\\x64\\signtool\.exe$") { 0 } elseif ($_.FullName -match "\\arm64\\signtool\.exe$") { 1 } else { 2 } } },
          FullName

      if (($candidates | Measure-Object).Count -gt 0) {
        return $candidates[0].FullName
      }
    }
  }

  Fail "signtool.exe was not found. Install the Windows SDK or set WINDOWS_SIGNTOOL_PATH."
}

$target = Resolve-RequiredFile $TargetPath "TargetPath"
$certificatePath = Resolve-RequiredFile $env:WINDOWS_CERTIFICATE_PATH "WINDOWS_CERTIFICATE_PATH"
$certificatePassword = $env:WINDOWS_CERTIFICATE_PASSWORD
if ([string]::IsNullOrWhiteSpace($certificatePassword)) {
  Fail "WINDOWS_CERTIFICATE_PASSWORD is required."
}

$timestampUrl = $env:WINDOWS_SIGNING_TIMESTAMP_URL
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
  $timestampUrl = "http://timestamp.digicert.com"
}

$signtool = Find-SignTool

Write-Host "[windows-sign] Signing $target"
& $signtool sign /fd SHA256 /td SHA256 /tr $timestampUrl /f $certificatePath /p $certificatePassword /d "June" $target
if ($LASTEXITCODE -ne 0) {
  Fail "signtool sign failed with exit code $LASTEXITCODE."
}

$signature = Get-AuthenticodeSignature -FilePath $target
if ($signature.Status -ne "Valid") {
  Fail "Authenticode signature is $($signature.Status) for $target. $($signature.StatusMessage)"
}

Write-Host "[windows-sign] Signature verified for $target"
