param(
  [string]$Version = "0.1.3",
  [string]$Repo = "Miguellunab/HMI-Rotty"
)

$ErrorActionPreference = "Stop"
$bundleDir = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis"
$installer = Get-ChildItem $bundleDir -Filter "*_${Version}_x64-setup.exe" | Select-Object -First 1

if (-not $installer) {
  throw "No NSIS installer found for version $Version in $bundleDir"
}

$sigPath = "$($installer.FullName).sig"
if (-not (Test-Path $sigPath)) {
  throw "Missing updater signature: $sigPath"
}

$fileName = $installer.Name
$assetFileName = $fileName.Replace(" ", ".")
$encodedFileName = [uri]::EscapeDataString($assetFileName)
$json = [ordered]@{
  version = $Version
  notes = "HMI Rotty $Version"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = (Get-Content -Raw $sigPath).Trim()
      url = "https://github.com/$Repo/releases/download/v$Version/$encodedFileName"
    }
  }
} | ConvertTo-Json -Depth 5

$output = Join-Path $PSScriptRoot "..\latest.json"
[System.IO.File]::WriteAllText($output, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote latest.json for $fileName"
