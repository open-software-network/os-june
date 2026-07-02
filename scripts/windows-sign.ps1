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

function First-NonBlank([string[]]$Values) {
  foreach ($value in $Values) {
    if (![string]::IsNullOrWhiteSpace($value)) {
      return $value
    }
  }
  return $null
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

function Find-ArtifactSigningDlib([string]$ConfiguredPath) {
  if (![string]::IsNullOrWhiteSpace($ConfiguredPath)) {
    return Resolve-RequiredFile $ConfiguredPath "ARTIFACT_SIGNING_DLIB_PATH"
  }

  $roots = @(
    $env:RUNNER_TEMP,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  ) | Where-Object { ![string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Container) }

  $candidates = foreach ($root in $roots) {
    Get-ChildItem -Path $root -Filter "Azure.CodeSigning.Dlib.dll" -Recurse -File -ErrorAction SilentlyContinue
  }

  $candidates = @($candidates) | Sort-Object `
    @{ Expression = { if ($_.FullName -match "\\x64\\Azure\.CodeSigning\.Dlib\.dll$") { 0 } elseif ($_.FullName -match "\\arm64\\Azure\.CodeSigning\.Dlib\.dll$") { 1 } else { 2 } } },
    FullName

  if ($candidates.Count -gt 0) {
    return $candidates[0].FullName
  }

  Fail "Azure.CodeSigning.Dlib.dll was not found. Install Microsoft.ArtifactSigning.Client or set ARTIFACT_SIGNING_DLIB_PATH."
}

function Get-ArtifactSigningConfig {
  $endpoint = First-NonBlank @($env:ARTIFACT_SIGNING_ENDPOINT, $env:AZURE_ARTIFACT_SIGNING_ENDPOINT)
  $accountName = First-NonBlank @($env:ARTIFACT_SIGNING_ACCOUNT_NAME, $env:AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME)
  $profileName = First-NonBlank @($env:ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME, $env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME)
  $dlibPath = First-NonBlank @($env:ARTIFACT_SIGNING_DLIB_PATH, $env:AZURE_ARTIFACT_SIGNING_DLIB_PATH)

  $values = @($endpoint, $accountName, $profileName)
  $configured = @($values | Where-Object { ![string]::IsNullOrWhiteSpace($_) }).Count
  if ($configured -eq 0) {
    return $null
  }
  if ($configured -ne $values.Count) {
    Fail "Artifact Signing requires ARTIFACT_SIGNING_ENDPOINT, ARTIFACT_SIGNING_ACCOUNT_NAME, and ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME."
  }

  return [pscustomobject]@{
    Endpoint = $endpoint
    AccountName = $accountName
    ProfileName = $profileName
    DlibPath = $dlibPath
  }
}

function New-ArtifactSigningMetadata([object]$Config) {
  $correlationId = First-NonBlank @($env:ARTIFACT_SIGNING_CORRELATION_ID, $env:GITHUB_RUN_ID)
  if (![string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT)) {
    $correlationId = "$correlationId/$env:GITHUB_RUN_ATTEMPT"
  }

  $metadata = [ordered]@{
    Endpoint = $Config.Endpoint
    CodeSigningAccountName = $Config.AccountName
    CertificateProfileName = $Config.ProfileName
  }
  if (![string]::IsNullOrWhiteSpace($correlationId)) {
    $metadata.CorrelationId = $correlationId
  }

  $metadataPath = Join-Path $env:TEMP "artifact-signing-metadata-$([Guid]::NewGuid().ToString('N')).json"
  $metadata | ConvertTo-Json -Depth 4 | Set-Content -Path $metadataPath -Encoding utf8
  return $metadataPath
}

function Verify-Signature([string]$Path) {
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ($signature.Status -ne "Valid") {
    Fail "Authenticode signature is $($signature.Status) for $Path. $($signature.StatusMessage)"
  }
}

$target = Resolve-RequiredFile $TargetPath "TargetPath"
$artifactConfig = Get-ArtifactSigningConfig
$certificatePathValue = $env:WINDOWS_CERTIFICATE_PATH
$certificatePassword = $env:WINDOWS_CERTIFICATE_PASSWORD
$pfxConfigured = ![string]::IsNullOrWhiteSpace($certificatePathValue) -or ![string]::IsNullOrWhiteSpace($certificatePassword)

if ($null -ne $artifactConfig -and $pfxConfigured) {
  Fail "Configure either Artifact Signing or WINDOWS_CERTIFICATE_PATH/WINDOWS_CERTIFICATE_PASSWORD, not both."
}

if ($null -eq $artifactConfig -and !$pfxConfigured) {
  Write-Host "[windows-sign] No Windows signing credentials are configured; skipping Authenticode signing."
  exit 0
}

$signtool = Find-SignTool

if ($null -ne $artifactConfig) {
  $dlibPath = Find-ArtifactSigningDlib $artifactConfig.DlibPath
  $metadataPath = New-ArtifactSigningMetadata $artifactConfig
  $timestampUrl = First-NonBlank @($env:WINDOWS_SIGNING_TIMESTAMP_URL, "http://timestamp.acs.microsoft.com")

  Write-Host "[windows-sign] Signing $target with Azure Artifact Signing profile $($artifactConfig.ProfileName)"
  & $signtool sign /fd SHA256 /td SHA256 /tr $timestampUrl /dlib $dlibPath /dmdf $metadataPath /d "June" $target
  if ($LASTEXITCODE -ne 0) {
    Fail "signtool Artifact Signing failed with exit code $LASTEXITCODE."
  }
} else {
  if ([string]::IsNullOrWhiteSpace($certificatePathValue)) {
    Fail "WINDOWS_CERTIFICATE_PATH is required when Windows signing is configured."
  }
  if ([string]::IsNullOrWhiteSpace($certificatePassword)) {
    Fail "WINDOWS_CERTIFICATE_PASSWORD is required when Windows signing is configured."
  }

  $certificatePath = Resolve-RequiredFile $certificatePathValue "WINDOWS_CERTIFICATE_PATH"
  $timestampUrl = First-NonBlank @($env:WINDOWS_SIGNING_TIMESTAMP_URL, "http://timestamp.digicert.com")

  Write-Host "[windows-sign] Signing $target with PFX certificate"
  & $signtool sign /fd SHA256 /td SHA256 /tr $timestampUrl /f $certificatePath /p $certificatePassword /d "June" $target
  if ($LASTEXITCODE -ne 0) {
    Fail "signtool PFX signing failed with exit code $LASTEXITCODE."
  }
}

Verify-Signature $target
Write-Host "[windows-sign] Signature verified for $target"
