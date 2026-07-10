$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Bundle = Join-Path $Root ".tauri-personas\personas"
$Cache = Join-Path $Root ".tauri-personas\cache"
$Native = Join-Path $Root ".tauri-personas\native"
$SegmentationArchive = Join-Path $Cache "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
$SegmentationDir = Join-Path $Cache "sherpa-onnx-pyannote-segmentation-3-0"
$EmbeddingModel = Join-Path $Cache "wespeaker_en_voxceleb_resnet34_LM.onnx"

New-Item -ItemType Directory -Force -Path $Bundle, $Cache, $Native | Out-Null

function Get-PinnedFile {
  param([string]$Url, [string]$Sha256, [string]$Destination)
  if (-not (Test-Path $Destination)) {
    Invoke-WebRequest -Uri $Url -OutFile "$Destination.partial"
    Move-Item -Force "$Destination.partial" $Destination
  }
  $Actual = (Get-FileHash -Algorithm SHA256 $Destination).Hash.ToLowerInvariant()
  if ($Actual -ne $Sha256) {
    throw "Checksum mismatch for $Destination`: expected $Sha256, got $Actual"
  }
}

Get-PinnedFile `
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" `
  "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488" `
  $SegmentationArchive
if (-not (Test-Path (Join-Path $SegmentationDir "model.onnx"))) {
  tar -xjf $SegmentationArchive -C $Cache
}
Get-PinnedFile `
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx" `
  "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012" `
  $EmbeddingModel
Get-PinnedFile `
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib.tar.bz2" `
  "d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c" `
  (Join-Path $Native "sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib.tar.bz2")

$SegmentationModel = Join-Path $SegmentationDir "model.onnx"
$ActualSegmentation = (Get-FileHash -Algorithm SHA256 $SegmentationModel).Hash.ToLowerInvariant()
if ($ActualSegmentation -ne "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079") {
  throw "Checksum mismatch for $SegmentationModel"
}

Copy-Item -Force $SegmentationModel (Join-Path $Bundle "segmentation.onnx")
Copy-Item -Force $EmbeddingModel (Join-Path $Bundle "embedding.onnx")
Copy-Item -Force (Join-Path $SegmentationDir "LICENSE") (Join-Path $Bundle "LICENSE-segmentation-mit.txt")
Copy-Item -Force (Join-Path $Root "src-tauri\resources\personas\THIRD_PARTY_NOTICES.txt") (Join-Path $Bundle "THIRD_PARTY_NOTICES.txt")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Bundle "PLACEHOLDER.md")
Set-Content -NoNewline -Path (Join-Path $Bundle "PIN") -Value "sherpa-onnx-1.13.4-wespeaker-voxceleb-resnet34-lm`n"

Write-Host "Bundled Persona models in $Bundle"
Write-Host "Verified sherpa-onnx native archive in $Native"
